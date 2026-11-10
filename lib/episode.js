/**
 * 回合（turn）→ Episode：检索的最小单元；State：每轮重写的「现在在干什么」。
 *
 * Episode 只从会话事件聚合，不推断、不调模型。一个 turn 一条，落
 * episodes/<workspaceKey>.jsonl；State 由最近一条 Episode 派生，落
 * state/<sessionId>.json 与同名 .md（人是看 md 的）。
 *
 * @typedef {Object} Episode
 * @property {number} schema
 * @property {string} id
 * @property {string} sid
 * @property {string} ws
 * @property {number} turn
 * @property {number} ts
 * @property {number|null} seqStart
 * @property {number|null} seqEnd
 * @property {string} user
 * @property {string} assistant
 * @property {string} [reasoning]
 * @property {Array<ToolCall>} toolCalls
 * @property {Array<string>} errors
 * @property {Array<Object>|null} todos
 * @property {boolean} corrected
 * @property {import('./source.js').MessageSource} [source]
 *
 * @typedef {Object} ToolCall
 * @property {string} callId
 * @property {string} name
 * @property {string} args
 * @property {string} result
 * @property {boolean} isError
 *
 * @typedef {Object} StateSnapshot
 * @property {number} schema
 * @property {string} sid
 * @property {number} turn
 * @property {number} updatedAt
 * @property {string} doing
 * @property {string} lastConclusion
 * @property {Array<string>} pending
 * @property {boolean} corrected
 */
import { join } from 'node:path'
import { appendJsonl, clip, oneLine, readJsonl, readTextIfExists, safeId, sha1, writeAtomic } from './util.js'
import { eventTs, messageOf, reasoningOf, textOf, workspaceKey } from './ledger.js'
import { cleanUserText, looksLikeQqText, parseSource } from './source.js'

export const EPISODE_SCHEMA = 1

/** Episode 各字段上限（字符）。 */
const EPISODE_LIMITS = {
  user: 4000,
  assistant: 6000,
  reasoning: 2000,
  toolName: 64,
  toolArgs: 300,
  toolResult: 600,
  error: 600,
  maxToolCalls: 40,
  maxErrors: 10,
}

/** State 各字段上限（字符），要小到能每轮塞进上下文。 */
const STATE_LIMITS = {
  doing: 160,
  lastConclusion: 240,
  pendingItem: 120,
  maxPending: 6,
}

/** 用户表达「你错了/你忘了」的信号。只用于记账，不做任何自动改写。 */
const CORRECTION_RE =
  /(不对|错了|不是这个|不是那个|不是这样|你记错|记错了|我说过|你又忘|又忘了|搞错|不要这样|别这样|重新来)/

export function isCorrection(text) {
  return CORRECTION_RE.test(String(text ?? ''))
}

export function episodeFile(layout, workspaceId) {
  return join(layout.episodes, `${safeId(workspaceId)}.jsonl`)
}

export function stateFile(layout, sessionId) {
  return join(layout.state, `${safeId(sessionId)}.json`)
}

export function stateTextFile(layout, sessionId) {
  return join(layout.state, `${safeId(sessionId)}.md`)
}

export function checkpointFile(layout, sessionId, compactionId) {
  return join(layout.checkpoints, `${safeId(sessionId)}-${safeId(compactionId)}.json`)
}

/** 一个会话的同一个 turn 只对应一个 id，重放也不会写出第二条。 */
export function episodeId(sessionId, turn) {
  return `ep-${sha1(`${sessionId}:${turn}`).slice(0, 12)}`
}

/**
 * 从会话事件里聚合一个 turn。
 * 事件来源是 session.snapshotEvents()，按 data.turn 过滤；没有正文的 turn 不产出。
 * @returns {Episode|null}
 */
export function buildTurn(session, turn, config) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  return buildTurnFromEvents(session, events, turn, config)
}

/**
 * 选出属于某个 turn 的事件。
 * user/message 没有 data.turn，只能按 seq 落在 turn/start 与 turn/end 之间来归。
 * @param {Array<Object>} events
 * @param {number} turn
 * @returns {Array<Object>}
 */
function eventsOfTurn(events, turn) {
  const wanted = Number(turn)
  const sorted = [...events].sort((a, b) => Number(a?.seq ?? 0) - Number(b?.seq ?? 0))
  const mine = []
  let current = null
  for (const event of sorted) {
    const type = event?.type
    if (type === 'turn/start') {
      current = Number(event?.data?.turn)
      continue
    }
    if (type === 'turn/end') {
      if (Number(event?.data?.turn) === wanted) mine.push(event)
      current = null
      continue
    }
    const explicit = Number(event?.data?.turn)
    if (Number.isFinite(explicit)) {
      if (explicit === wanted) mine.push(event)
      continue
    }
    if (current === wanted) mine.push(event)
  }
  return mine
}

/** 只把真正由人发出的消息当作「用户原话」；注入块（runtime-context 等）不算。 */
function isHumanUserMessage(data, text) {
  const kind = data?.source?.kind
  if (kind === undefined || kind === 'user' || kind === 'plugin:dsh-onebot') return true
  // 未知桥接插件但正文是 QQ 信封，也算人说的。
  return looksLikeQqText(text)
}

/**
 * 同 buildTurn，但事件由调用方给出。导入历史日志时没有活的 session 对象，
 * 传一个带 id / header.cwd 的壳即可。
 * @param {{id?:string, header?:{cwd?:string}}} session
 * @param {Array<Object>} events
 * @param {number} turn
 * @param {{captureReasoning?:boolean}} [config]
 * @returns {Episode|null}
 */
export function buildTurnFromEvents(session, events, turn, config) {
  const sessionId = String(session?.id ?? '')
  if (sessionId === '' || !Number.isFinite(Number(turn))) return null
  const mine = eventsOfTurn(events, turn)
  if (mine.length === 0) return null

  const users = []
  const userSources = []
  const assistants = []
  const reasonings = []
  const toolCalls = []
  const errors = []
  let todos = null
  let seqStart = null
  let seqEnd = null

  for (const event of mine) {
    const seq = Number(event?.seq)
    if (Number.isFinite(seq)) {
      seqStart = seqStart === null ? seq : Math.min(seqStart, seq)
      seqEnd = seqEnd === null ? seq : Math.max(seqEnd, seq)
    }
    const data = event?.data ?? {}
    if (event?.type === 'user/message') {
      const raw = textOf(messageOf(session, event))
      if (!isHumanUserMessage(data, raw)) continue
      if (raw === '') continue
      const source = parseSource(sessionId, data, raw)
      userSources.push(source)
      users.push(cleanUserText(raw, source) || raw)
      continue
    }
    if (event?.type === 'assistant/message') {
      const text = textOf(messageOf(session, event))
      if (text !== '') assistants.push(text)
      const reasoning = reasoningOf(messageOf(session, event))
      if (reasoning !== '') reasonings.push(reasoning)
      continue
    }
    if (event?.type === 'tool/call') {
      toolCalls.push({
        callId: String(data.callId ?? ''),
        name: clip(String(data.name ?? ''), EPISODE_LIMITS.toolName),
        args: clip(String(data.arguments ?? ''), EPISODE_LIMITS.toolArgs),
        result: '',
        isError: false,
      })
      continue
    }
    if (event?.type === 'tool/result') {
      const message = messageOf(session, event)
      const callId = String(data.toolCallId ?? message?.toolCallId ?? '')
      const result = clip(textOf(message), EPISODE_LIMITS.toolResult)
      const isError = Boolean(data.isError)
      const call = toolCalls.find((item) => item.callId === callId && item.result === '')
      if (call) {
        call.result = result
        call.isError = isError
      } else {
        toolCalls.push({ callId, name: '', args: '', result, isError })
      }
      if (isError) errors.push(clip(result, EPISODE_LIMITS.error))
      continue
    }
    if (event?.type === 'todo/write') {
      todos = data.todos ?? data.items ?? data.tasks ?? null
    }
  }

  if (users.length === 0 && assistants.length === 0) return null

  const userText = users.join('\n\n')
  const episode = {
    schema: EPISODE_SCHEMA,
    id: episodeId(sessionId, Number(turn)),
    sid: sessionId,
    ws: workspaceKey(session?.header?.cwd ?? session?.cwd),
    turn: Number(turn),
    ts: eventTs(mine[mine.length - 1]),
    seqStart,
    seqEnd,
    user: clip(userText, EPISODE_LIMITS.user),
    assistant: clip(assistants[assistants.length - 1] ?? '', EPISODE_LIMITS.assistant),
    toolCalls: toolCalls.slice(0, EPISODE_LIMITS.maxToolCalls),
    errors: errors.slice(0, EPISODE_LIMITS.maxErrors),
    todos,
    corrected: isCorrection(userText),
  }
  if (userSources.length > 0) {
    episode.source = { ...userSources[0] }
    const names = [...new Set(userSources.map((item) => item.speakerName).filter(Boolean))]
    if (names.length > 1) episode.source.speakers = names
  }
  if (config?.captureReasoning === true) {
    episode.reasoning = clip(reasonings.join('\n\n'), EPISODE_LIMITS.reasoning)
  }
  return episode
}

/** 每个工作区文件已有哪些 Episode id；进程内缓存，避免每轮重读大文件。 */
const knownIds = new Map()

function idsOf(file) {
  let ids = knownIds.get(file)
  if (!ids) {
    ids = new Set(readJsonl(file).map((row) => row?.id).filter((id) => typeof id === 'string'))
    knownIds.set(file, ids)
  }
  return ids
}

/**
 * 追加一条 Episode；同一个 turn 只留第一条（id 是确定性的）。
 * 历史导入与实时捕获会撞 id，这里统一去重。
 * @returns {boolean} 是否真的写入
 */
export function appendEpisode(layout, episode) {
  const file = episodeFile(layout, episode.ws)
  const ids = idsOf(file)
  if (ids.has(episode.id)) return false
  ids.add(episode.id)
  appendJsonl(file, episode)
  return true
}

/**
 * 由 Episode 派生本轮状态。pending 优先取 todo 里未完成项，没有就继承上一轮。
 * @returns {StateSnapshot}
 */
export function buildState(sessionId, episode, previous) {
  const openTodos = Array.isArray(episode?.todos)
    ? episode.todos
        .filter((item) => item && (item.status === 'pending' || item.status === 'in_progress') && typeof item.content === 'string')
        .map((item) => clip(item.content, STATE_LIMITS.pendingItem))
    : []
  const pending =
    openTodos.length > 0 ? openTodos.slice(0, STATE_LIMITS.maxPending) : (previous?.pending ?? []).slice(0, STATE_LIMITS.maxPending)
  return {
    schema: EPISODE_SCHEMA,
    sid: sessionId,
    turn: Number(episode?.turn ?? 0),
    updatedAt: Date.now(),
    doing: oneLine(episode?.user ?? '', STATE_LIMITS.doing),
    lastConclusion: oneLine(episode?.assistant ?? '', STATE_LIMITS.lastConclusion),
    pending,
    corrected: Boolean(episode?.corrected),
  }
}

/** 同时写 json（机器读）和 md（人看）。 */
export function writeState(layout, state) {
  writeAtomic(stateFile(layout, state.sid), `${JSON.stringify(state, null, 2)}\n`)
  writeAtomic(stateTextFile(layout, state.sid), renderStateMarkdown(state))
}

export function renderStateMarkdown(state) {
  const lines = [
    '# 当前状态（每轮自动重写，不要手改）',
    '',
    `- 更新时间：${new Date(state.updatedAt).toISOString()}`,
    `- 在做：${state.doing === '' ? '（未知）' : state.doing}`,
    `- 上次结论：${state.lastConclusion === '' ? '（无）' : state.lastConclusion}`,
    '- 未完成：',
  ]
  if (state.pending.length === 0) lines.push('  - （无）')
  for (const item of state.pending) lines.push(`  - ${item}`)
  if (state.corrected) lines.push('- 注意：本轮用户纠正过，下轮不要复用被纠正的说法。')
  return `${lines.join('\n')}\n`
}

export function readState(layout, sessionId) {
  const text = readTextIfExists(stateFile(layout, sessionId))
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 压缩前留一份快照：压缩会换掉历史，但状态必须还在。 */
export function snapshotState(layout, state, compactionId) {
  writeAtomic(checkpointFile(layout, state.sid, compactionId), `${JSON.stringify({ ...state, compactionId }, null, 2)}\n`)
}
