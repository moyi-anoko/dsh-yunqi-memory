/**
 * L1 事件账本：会话里发生过的每条事件都原样追加，只增不改。
 *
 * 这里是「可回原文」的底：检索不到、摘要丢了、上下文被压缩了，都还能回到
 * 这一行。工具结果按配置截断（默认 1200 字），因为它通常又长又只对当轮有用。
 *
 * @typedef {Object} SessionEventRow
 * @property {number} schema
 * @property {number|null} seq
 * @property {string} type
 * @property {number} ts
 * @property {number|null} turn
 * @property {number|null} step
 * @property {string|null} [role]
 * @property {string} [text]
 * @property {string} [reasoning]
 * @property {string} [tool]
 * @property {string} [args]
 * @property {string} [toolCallId]
 * @property {boolean} [isError]
 * @property {Array<Object>|null} [todos]
 * @property {string|null} [reason]
 * @property {string|null} [compactionId]
 */
import { join } from 'node:path'
import { appendJsonl, clip, safeId, sha1 } from './util.js'
import { parseSource } from './source.js'

/** 账本每行都带 schema，改格式时按版本读，不靠“代码里没有就是没写过”。 */
export const LEDGER_SCHEMA = 1

/** 单条事件各字段的截断上限（字符）。 */
const EVENT_LIMITS = {
  messageText: 12000,
  reasoning: 4000,
  toolName: 80,
  toolArgs: 600,
  toolResult: 1200,
}

/**
 * 数据目录布局。所有模块只认这一个入口，不各自拼路径。
 * @returns {{root:string,sessions:string,episodes:string,state:string,checkpoints:string,memory:string,persona:string,history:string,usage:string,judgments:string,audit:string}}
 */
export function layoutOf(root) {
  return {
    root,
    sessions: join(root, 'sessions'),
    episodes: join(root, 'episodes'),
    state: join(root, 'state'),
    checkpoints: join(root, 'state', 'checkpoints'),
    memory: join(root, 'memory'),
    persona: join(root, 'persona'),
    history: join(root, 'persona', 'history'),
    usage: join(root, 'usage.jsonl'),
    judgments: join(root, 'judgments.jsonl'),
    audit: join(root, 'audit.jsonl'),
  }
}

/** 工作区键：同一个目录的会话共享检索池。空目录名归到 shared。 */
export function workspaceKey(cwd) {
  const text = String(cwd ?? '').trim().toLowerCase()
  return text === '' ? 'shared' : sha1(text).slice(0, 10)
}

/** 会话原文账本文件。一个会话一个文件，按会话 id 命名。 */
export function sessionFile(layout, sessionId) {
  return join(layout.sessions, `${safeId(sessionId)}.jsonl`)
}

/**
 * 事件 → 消息对象。DSH 的 message 事件把消息放在 data.message 里，
 * 但宿主提供 deriveEventMessage() 时以它为准（它还处理了派生/修补）。
 */
export function messageOf(session, event) {
  try {
    const derived = session?.deriveEventMessage?.(event)
    if (derived) return derived
  } catch {
    /* 派生失败不是错误，退回原始 data。 */
  }
  const data = event?.data
  return data?.message ?? data ?? null
}

export function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** reasoning 单独取：它和正文不是一回事，检索默认不用它。 */
export function reasoningOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block && (block.type === 'reasoning' || block.type === 'thinking') && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

export function eventTs(event) {
  const value = Number(event?.time ?? event?.timestamp)
  return Number.isFinite(value) && value > 0 ? value : Date.now()
}

/** 把一条会话事件压成账本行。缺字段不报错，宁可少记也不让捕获中断。 */
export function describeEvent(session, event) {
  const type = event?.type ?? 'unknown'
  const data = event?.data ?? {}
  const base = {
    schema: LEDGER_SCHEMA,
    seq: Number.isFinite(Number(event?.seq)) ? Number(event.seq) : null,
    type,
    ts: eventTs(event),
    turn: data.turn ?? null,
    step: data.step ?? null,
  }
  if (type === 'user/message' || type === 'assistant/message') {
    const message = messageOf(session, event)
    const text = clip(textOf(message), EVENT_LIMITS.messageText)
    const row = {
      ...base,
      role: message?.role ?? (type === 'user/message' ? 'user' : 'assistant'),
      text,
      reasoning: clip(reasoningOf(message), EVENT_LIMITS.reasoning),
    }
    if (type === 'user/message') row.source = parseSource(session?.id, data, text)
    return row
  }
  if (type === 'tool/call') {
    return {
      ...base,
      tool: clip(String(data.name ?? data.tool ?? ''), EVENT_LIMITS.toolName),
      args: clip(String(data.arguments ?? data.args ?? ''), EVENT_LIMITS.toolArgs),
    }
  }
  if (type === 'tool/result') {
    const message = messageOf(session, event)
    return {
      ...base,
      toolCallId: String(data.toolCallId ?? message?.toolCallId ?? ''),
      text: clip(textOf(message), EVENT_LIMITS.toolResult),
      isError: Boolean(data.isError ?? message?.isError),
    }
  }
  if (type === 'todo/write') {
    return { ...base, todos: data.todos ?? data.items ?? data.tasks ?? null }
  }
  if (type === 'turn/end') {
    return { ...base, reason: data.reason?.kind ?? data.reason ?? null }
  }
  if (type === 'compaction/start' || type === 'compaction/summary') {
    return { ...base, compactionId: data.compactionId ?? null }
  }
  return base
}

/**
 * 捕获入口。只认会话里真实发生的事件，不生成、不推断。
 * 这个函数在 session/event 回调里对每条事件调用一次，必须足够轻。
 */
export function captureEvent(session, event, config) {
  const sessionId = session?.id
  if (typeof sessionId !== 'string' || sessionId === '') return
  const row = describeEvent(session, event)
  if (row.reasoning === '') delete row.reasoning
  if (row.type === 'assistant/message' && config.captureReasoning !== true) delete row.reasoning
  if (row.type === 'tool/result' && config.captureToolResults !== true) return
  appendJsonl(sessionFile(layoutOf(config.root), sessionId), row)
}
