/**
 * dsh-yunqi-memory：状态层 + 判断账本 + 可回原文 + 受控人格。
 *
 * 注入只五样：
 *   1) 身份块（persona/stable.md + 已采纳成长）——稳定，进 systemPrompt.section
 *   2) 长期记忆摘录（persona/memory.md）——稳定，进 systemPrompt.section
 *   3) 使用政策——稳定，进 systemPrompt.section
 *   4) 当前状态（在做/上次结论/未完成）——每轮变，进 systemPrompt.context
 *   5) 旧事与细节——不进上下文，模型自己用 yunqi_recall 查
 *
 * 稳定核由模型自己维护（yunqi_persona action=rewrite，旧版自动进 persona/history/），
 * 主人随时可以改文件；config.identityInject 设为 false 才会关掉身份块。
 *
 * 不做的事：不接管压缩、不改会话历史、不自动改写人格、不联网。
 */
import { ensureDir } from './lib/util.js'
import { captureEvent, layoutOf, messageOf, textOf } from './lib/ledger.js'
import { appendEpisode, buildState, buildTurn, readState, snapshotState, writeState, isCorrection } from './lib/episode.js'
import { renderIdentity, renderMemory } from './lib/persona.js'
import { loadUsage, recordCorrect, recentCitations } from './lib/judge.js'
import { rootDir } from './lib/paths.js'
import { registerTools } from './lib/tools.js'
import { auditInject } from './lib/inject.js'
import { appendJsonl } from './lib/util.js'

export const name = 'yunqi-memory'
export const inject = ['systemPrompt', 'tools']

const DEFAULTS = {
  captureReasoning: true,
  captureToolResults: false,
  stateInject: true,
  identityInject: true,
  /** 注入被预算截断时写一行回执（audit type:'inject'）。只读、可关。 */
  injectAudit: true,
  /** 写入前查重：完全重复不写，半重复合并。关掉就退回裸追加。 */
  writeGate: true,
  /** 写入时必须带 evidence 才算活事实；0 表示关闭晋升门槛（默认关）。 */
  promoteAfter: 0,
}

const POLICY = [
  '【记忆使用政策】',
  '- 上下文里没有的旧事，先用 yunqi_recall 查，查不到就说不知道，不要凭印象补。',
  '- 用了查到的内容，只把真用上的那一条在 yunqi_recall 里传 cite: true 记账。',
  '- 被主人纠正过的说法，下一轮不要复用。',
  '- 装新功能/插件前先答三条：出错时谁先发现、代价落在谁身上、它有几个开关；拆完留一行「删了什么、为什么」。',
  '- 人格可以自己写（yunqi_persona action=rewrite，旧版自动留档）；成长提案只有主人能采纳，你不要自己 accept。',
].join('\n')

const STATE_LIMIT = 700

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const root = rootDir(config)
  config.root = root
  const layout = layoutOf(root)
  for (const dir of [root, layout.sessions, layout.episodes, layout.state, layout.checkpoints, layout.memory, layout.persona, layout.history]) {
    ensureDir(dir)
  }

  const recordInject = (trace) => {
    if (config.injectAudit !== true) return
    try {
      auditInject(layout, trace)
    } catch {
      /* 回执写不进去不影响注入本身；注入坏了才是大事。 */
    }
  }

  // 人设由本插件自己维护；identityInject=false 时才让位给别的插件。
  if (config.identityInject === true) {
    ctx.systemPrompt.section({
      name: 'yunqi:identity',
      order: 0.2,
      text: () => {
        const trace = {}
        const text = renderIdentity(layout, trace)
        recordInject(trace)
        return text
      },
    })
    ctx.systemPrompt.section({
      name: 'yunqi:memory',
      order: 0.22,
      text: () => {
        const trace = {}
        const text = renderMemory(layout, 1800, Date.now(), { trace, promoteAfter: config.promoteAfter })
        recordInject(trace)
        return text
      },
    })
  }

  ctx.systemPrompt.section({
    name: 'yunqi:policy',
    order: 0.25,
    text: () => POLICY,
  })

  ctx.systemPrompt.context({
    name: 'yunqi:now',
    order: 900,
    text: (context) => {
      if (config.stateInject !== true) return ''
      const session = context?.agent?.session
      const state = readState(layout, String(session?.id ?? ''))
      if (!state) return ''
      const text = renderNowBlock(state)
      const out = text.length > STATE_LIMIT ? `${text.slice(0, STATE_LIMIT)}…` : text
      recordInject({ name: 'yunqi:now', budget: STATE_LIMIT, chars: out.length, fullChars: text.length })
      return out
    },
  })

  const lastState = new Map()

  const rememberCorrections = (session, text) => {
    if (!isCorrection(text)) return
    const sessionId = String(session?.id ?? '')
    const recent = recentCitations(loadUsage(layout).filter((row) => row.sessionId === sessionId))
    for (const episodeId of [...recent.keys()].slice(0, 3)) {
      recordCorrect(layout, { episodeId, sessionId, note: text.slice(0, 120) })
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      captureEvent(session, event, config)
      if (event?.type === 'user/message') {
        rememberCorrections(session, textOf(messageOf(session, event)))
        return
      }
      if (event?.type === 'compaction/start') {
        const sessionId = String(session?.id ?? '')
        const state = lastState.get(sessionId) ?? readState(layout, sessionId)
        if (state) snapshotState(layout, state, String(event?.data?.compactionId ?? event?.seq ?? 'cp'))
        return
      }
      if (event?.type === 'turn/end') finishTurn(session, Number(event?.data?.turn))
    } catch (error) {
      // 记忆坏了不能弄坏对话本身；只留一行审计，不重试。
      try {
        appendJsonl(layout.audit, { schema: 1, type: 'error', ts: Date.now(), message: String(error?.message ?? error) })
      } catch {
        /* 连审计都写不了就放弃，不抛给宿主 */
      }
    }
  })

  function finishTurn(session, turn) {
    if (!Number.isFinite(turn)) return
    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return
    const episode = buildTurn(session, turn, config)
    if (!episode) return
    appendEpisode(layout, episode)
    const previous = lastState.get(sessionId) ?? readState(layout, sessionId)
    const state = buildState(sessionId, episode, previous)
    writeState(layout, state)
    lastState.set(sessionId, state)
    appendJsonl(layout.audit, {
      schema: 1,
      type: 'turn',
      ts: Date.now(),
      sessionId,
      ws: episode.ws,
      turn,
      episodeId: episode.id,
      seqStart: episode.seqStart,
      seqEnd: episode.seqEnd,
    })
  }

  registerTools(ctx, config, layout)
}

function renderNowBlock(state) {
  const lines = ['【现在】', `- 在做：${state.doing === '' ? '（未知）' : state.doing}`]
  if (state.lastConclusion !== '') lines.push(`- 上次结论：${state.lastConclusion}`)
  if (state.pending.length > 0) lines.push(`- 未完成：${state.pending.join('；')}`)
  return lines.join('\n')
}
