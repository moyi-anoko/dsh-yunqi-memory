/**
 * 给模型用的 3 个工具。工具是「按需取」的入口：上下文里只放状态和少量命中，
 * 真正翻旧账靠这里；recall 时传 cite:true 记账——这是判断账本唯一的写入路径。
 */
import { clip, localStamp } from './util.js'
import { workspaceKey } from './ledger.js'
import { loadUsage, recordCite, recordSurface } from './judge.js'
import { appendFact, assessFact, factsFile, loadFacts } from './facts.js'
import { search } from './recall.js'
import { sessionLabel, sourceLabel } from './source.js'
import { decide, pendingProposals, growableEntries, propose, writeStable } from './persona.js'

const FACT_LIMITS = { text: 400, maxTags: 6, tag: 40, maxSupersedes: 8 }
const HIT_TEXT = 220

export function registerTools(ctx, config, layout) {
  ctx.tools.register({
    name: 'yunqi_recall',
    description:
      '按线索检索自己过去的对话回合。上下文里没有的旧事，先来这里查，不要凭印象编。返回命中的回合原文片段与出处（episodeId / 会话 / 时间）；查到的条目会被记一次 surface。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '线索词或一句话，例如“上次说的那个记忆插件”。' },
        limit: { type: 'integer', description: '最多返回几条，默认 5。' },
        crossWorkspace: { type: 'boolean', description: '默认只查当前工作区；true 时查全部工作区。' },
        channel: {
          type: 'string',
          enum: ['any', 'harness', 'qq:group', 'qq:private', 'injected', 'diary', 'fact'],
          description: '按来源过滤：any（默认）/ harness（DSH 界面）/ qq:group / qq:private / injected / diary（日记与笔记）/ fact（我记下的事实）。',
        },
        cite: { type: 'boolean', description: 'true 时把返回的第一条记为「真进了回答」（写判断账本）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'hits'],
        properties: {
          count: { type: 'integer' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['episodeId', 'when', 'user', 'assistant'],
              properties: {
                episodeId: { type: 'string' },
                when: { type: 'string' },
                user: { type: 'string' },
                assistant: { type: 'string' },
                channel: { type: 'string' },
                session: { type: 'string' },
                source: { type: 'string' },
                score: { type: 'number' },
              },
            },
          },
        },
      },
      render(_args, value) {
        if (value.count === 0) return [{ type: 'text', text: '没有命中。' }]
        return [{ type: 'text', text: value.hits.map(formatHit).join('\n\n') }]
      },
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      const sessionId = String(session?.id ?? '')
      const query = String(args.query ?? '').trim()
      if (query === '') throw new Error('yunqi_recall: query 不能为空')
      const hits = search(layout, {
        ws: workspaceKey(session?.header?.cwd),
        query,
        limit: Math.min(Math.max(Number(args.limit ?? 5), 1), 20),
        crossWorkspace: args.crossWorkspace === true,
        channel: args.channel && args.channel !== 'any' ? String(args.channel) : '',
        usage: loadUsage(layout),
      })
      for (const hit of hits) recordSurface(layout, { episodeId: hit.id, sessionId, query })
      if (args.cite === true && hits.length > 0) {
        recordCite(layout, { episodeId: hits[0].id, sessionId, query })
      }
      return {
        count: hits.length,
        hits: hits.map((hit) => ({
          episodeId: hit.id,
          when: localStamp(hit.ts),
          user: clip(hit.user, HIT_TEXT),
          assistant: clip(hit.assistant, HIT_TEXT),
          channel: hit.channel,
          session: sessionLabel(hit.sid, { currentSid: sessionId, channel: hit.channel }),
          source: sourceLabel({ channel: hit.channel, speakerName: hit.speakerName }),
          score: Number(hit.score.toFixed(3)),
        })),
      }
    },
  })

  ctx.tools.register({
    name: 'yunqi_remember',
    description:
      '把一条值得跨会话保留的事实写进记忆库（只追加，不改旧条目）。适合用户偏好、约定、身份信息。旧事实说错了别硬删：传 supersedes 带上旧 id，它会被标作废、正文不动。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '一句话事实，尽量自包含。' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，最多 6 个。' },
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description: '要作废的旧事实 id（yunqi_recall channel=fact 能看到）。作废只追加标记，旧正文保留。',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: '凭什么记这条：来源 Episode id（yunqi_recall 返回的）。不传时按配置记成待晋升候选。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'total', 'retired'],
        properties: {
          id: { type: 'string' },
          total: { type: 'integer' },
          retired: { type: 'array', items: { type: 'string' } },
          state: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.state === 'DROP') {
          return [{ type: 'text', text: `这条已经记过了（${value.id}），没有重复写。` }]
        }
        const retired = Array.isArray(value.retired) ? value.retired : []
        const tail = retired.length === 0 ? '' : `，作废了 ${retired.join('、')}`
        return [{ type: 'text', text: `已记住（${value.id}），记忆库现有 ${value.total} 条${tail}。` }]
      },
    },
    async execute(args, exec) {
      const text = String(args.text ?? '').trim()
      if (text === '') throw new Error('yunqi_remember: text 不能为空')
      const session = exec?.agent?.session
      const explicit = (Array.isArray(args.supersedes) ? args.supersedes : []).slice(0, FACT_LIMITS.maxSupersedes)
      const active = loadFacts(layout).facts
      // 显式 supersedes 说明模型知道自己在改哪条；写入前判定只挡「没意识到的重复」。
      const verdict = explicit.length === 0 && config.writeGate === true ? assessFact(active, text) : { state: 'ACCEPT' }
      if (verdict.state === 'DROP') {
        return { id: String(verdict.duplicateOf ?? ''), total: active.length, retired: [], state: 'DROP' }
      }
      const supersedes = explicit.length > 0 ? explicit : verdict.state === 'MERGE' ? [verdict.mergeInto] : []
      const evidence = (Array.isArray(args.evidence) ? args.evidence : []).filter((item) => typeof item === 'string' && item !== '')
      const { fact, retired } = appendFact(factsFile(layout), {
        text: clip(text, FACT_LIMITS.text),
        tags: args.tags,
        supersedes,
        evidence,
        state: config.promoteAfter > 0 && evidence.length === 0 ? 'candidate' : 'active',
        sessionId: String(session?.id ?? ''),
        ws: workspaceKey(session?.header?.cwd),
        ts: Date.now(),
      })
      return { id: fact.id, total: loadFacts(layout).facts.length, retired, state: verdict.state }
    },
  })

  ctx.tools.register({
    name: 'yunqi_persona',
    description:
      '人格。rewrite 重写稳定核（自己写，旧版自动存进 persona/history/，主人可随后修改）；list 看已采纳与待定提案；propose 写一条带依据（Episode id）的成长提案；accept/reject 只能由人明确决定时调用，AI 不要自己采纳。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['rewrite', 'list', 'propose', 'accept', 'reject'] },
        text: { type: 'string', description: 'rewrite 时的新稳定核全文；propose 时的成长内容。' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'propose 时引用的 Episode id。' },
        entryId: { type: 'string', description: 'accept/reject 时的提案 id。' },
        note: { type: 'string', description: 'accept/reject 时的理由。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          bytes: { type: 'number' },
          accepted: { type: 'array', items: { type: 'string' } },
          pending: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.message ?? `ok: ${value.ok}` }]
      },
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (args.action === 'rewrite') {
        const result = writeStable(layout, args.text)
        return {
          ok: true,
          bytes: result.bytes,
          message: `稳定核已重写（${result.bytes} 字节）${result.backup === null ? '，旧版不存在' : `，旧版备份在 ${result.backup}`}`,
        }
      }
      if (args.action === 'list') {
        const accepted = growableEntries(layout).map((entry) => `${entry.id} ${entry.text}`)
        const pending = pendingProposals(layout).map((entry) => `${entry.id} ${entry.text}`)
        return { ok: true, accepted, pending, message: renderPersonaList(accepted, pending) }
      }
      if (args.action === 'propose') {
        const entry = propose(layout, {
          text: args.text,
          evidence: args.evidence,
          sessionId: String(session?.id ?? ''),
        })
        return { ok: true, id: entry.id, message: `提案已记下：${entry.id}（等主人决定）` }
      }
      const entryId = String(args.entryId ?? '')
      if (entryId === '') throw new Error('yunqi_persona: 缺少 entryId')
      decide(layout, { entryId, status: args.action === 'accept' ? 'accepted' : 'rejected', note: args.note })
      return { ok: true, id: entryId, message: `已${args.action === 'accept' ? '采纳' : '拒绝'}：${entryId}` }
    },
  })

  return { recall: true }
}

function formatHit(hit) {
  // session 为空时退回原格式（老数据、认不出的会话名）。
  const parts = [hit.when]
  if (hit.session) parts.push(hit.session)
  if (hit.source) parts.push(hit.source)
  return `[${parts.join(' · ')}] ${hit.user}\n→ ${hit.assistant}\n(${hit.episodeId})`
}

function renderPersonaList(accepted, pending) {
  const a = accepted.length === 0 ? '（无）' : accepted.map((line) => `  - ${line}`).join('\n')
  const p = pending.length === 0 ? '（无）' : pending.map((line) => `  - ${line}`).join('\n')
  return `已采纳：\n${a}\n待定：\n${p}`
}
