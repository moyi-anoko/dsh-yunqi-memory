/**
 * 人格：稳定核（AI 自己写，主人可改）+ 受控成长（提案 → 采纳/拒绝）。
 *
 * 规则：
 * - 稳定核由 AI 自己维护，每次重写先把旧版存进 persona/history/，可回滚。
 * - 成长条目必须带 evidence（来自哪几条 Episode），不带依据的提案一律显示为「待定」。
 * - 成长提案只有人明确采纳才进上下文；AI 不要自己 accept。
 *
 * @typedef {Object} PersonaEntry
 * @property {number} schema
 * @property {string} id
 * @property {string} text
 * @property {Array<string>} evidence
 * @property {string} sessionId
 * @property {number} ts
 */
import { join } from 'node:path'
import { appendJsonl, clip, readJsonl, readTextIfExists, sha1, writeAtomic } from './util.js'
import { loadFacts, renderFacts } from './facts.js'

export const PERSONA_SCHEMA = 1

const LIMITS = {
  entryText: 300,
  stableChars: 4000,
  identityChars: 2400,
  maxEntries: 12,
  /** 事实清单在长期记忆段里的独立预算：memory.md 写再长也挤不掉它。 */
  factChars: 800,
}

export function stableFile(layout) {
  return join(layout.persona, 'stable.md')
}

export function growableFile(layout) {
  return join(layout.persona, 'growable.jsonl')
}

export function decisionsFile(layout) {
  return join(layout.persona, 'decisions.jsonl')
}

export function stableText(layout) {
  return clip(readTextIfExists(stableFile(layout)), LIMITS.stableChars)
}

/**
 * 重写稳定核。旧版先存进 persona/history/，避免一次改坏就找不回来。
 * @returns {{bytes: number, backup: string | null}}
 */
export function writeStable(layout, text) {
  const next = clip(String(text ?? ''), LIMITS.stableChars)
  if (next.trim() === '') throw new Error('稳定核不能为空')
  const previous = readTextIfExists(stableFile(layout))
  let backup = null
  if (previous.trim() !== '') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backup = join(layout.history, `stable-${stamp}.md`)
    writeAtomic(backup, previous)
  }
  writeAtomic(stableFile(layout), next)
  return { bytes: Buffer.byteLength(next, 'utf8'), backup }
}

/** 已采纳的成长条目（按 decisions 最新一条决定状态，后写的覆盖先写的）。 */
export function growableEntries(layout) {
  const entries = readJsonl(growableFile(layout)).filter((entry) => entry && typeof entry.text === 'string')
  const status = new Map()
  for (const decision of readJsonl(decisionsFile(layout))) {
    if (decision && typeof decision.entryId === 'string') status.set(decision.entryId, decision.status)
  }
  return entries
    .filter((entry) => status.get(entry.id) === 'accepted')
    .slice(-LIMITS.maxEntries)
    .map((entry) => ({ ...entry, text: clip(entry.text, LIMITS.entryText) }))
}

export function pendingProposals(layout) {
  const entries = readJsonl(growableFile(layout)).filter((entry) => entry && typeof entry.text === 'string')
  const decided = new Set(readJsonl(decisionsFile(layout)).map((decision) => decision?.entryId).filter(Boolean))
  return entries.filter((entry) => !decided.has(entry.id))
}

/** 写提案。evidence 是 Episode id 数组；没有依据也允许写，但会标成「无依据」。 */
export function propose(layout, input) {
  const text = clip(String(input?.text ?? ''), LIMITS.entryText)
  if (text === '') throw new Error('提案内容不能为空')
  const ts = Number(input?.ts ?? Date.now())
  const id = `pg-${sha1(`${text}:${ts}:${input?.sessionId ?? ''}`).slice(0, 12)}`
  const entry = {
    schema: PERSONA_SCHEMA,
    id,
    text,
    evidence: Array.isArray(input?.evidence) ? input.evidence.filter((item) => typeof item === 'string').slice(0, 8) : [],
    sessionId: String(input?.sessionId ?? ''),
    ts,
  }
  appendJsonl(growableFile(layout), entry)
  return entry
}

/** 采纳或拒绝。拒绝也留档，避免同一个提案反复弹出来。 */
export function decide(layout, input) {
  const entryId = String(input?.entryId ?? '')
  const status = input?.status === 'accepted' ? 'accepted' : 'rejected'
  if (entryId === '') throw new Error('缺少 entryId')
  const decision = {
    schema: PERSONA_SCHEMA,
    entryId,
    status,
    ts: Number(input?.ts ?? Date.now()),
    note: clip(String(input?.note ?? ''), 200),
  }
  appendJsonl(decisionsFile(layout), decision)
  return decision
}

/**
 * 渲染身份块。stable 永远在，growable 只取已采纳的；总长有上限，
 * 状态块才是每轮变化的部分，这里保持稳定。
 */
export function renderIdentity(layout, trace = null) {
  const stable = stableText(layout)
  const entries = growableEntries(layout)
  const lines = []
  if (stable !== '') lines.push(stable)
  if (entries.length > 0) {
    lines.push('')
    lines.push('【已采纳的成长（只作参考，不覆盖稳定核）】')
    for (const entry of entries) lines.push(`- ${entry.text}`)
  }
  const full = lines.join('\n')
  const text = clip(full, LIMITS.identityChars)
  if (trace !== null && typeof trace === 'object') {
    Object.assign(trace, { name: 'yunqi:identity', budget: LIMITS.identityChars, chars: text.length, fullChars: full.length })
  }
  return text
}

/** 超过这个天数没复核的长期记忆，注入时加标记，不静默当新事实用。 */
export const MEMORY_STALE_DAYS = 45

/**
 * 长期记忆摘录（只注入，不参与成长）。
 * memory.md 里每条以 `- (YYYY-MM-DD) ` 开头；超过 45 天的条目追加「久未复核」。
 */
/**
 * 长期记忆摘录 = memory.md（人写的/导入的）+ 事实层（yunqi_remember 写的）。
 *
 * 两段给独立预算：memory.md 可能很长，但不该把事实全挤掉——事实是模型自己记下、
 * 还带着作废标记的那一层，进不了上下文就等于白记（这是改造前的真实缺陷）。
 * 两边都标「久未复核」，过期的不能静默冒充今天的口径。
 */
export function renderMemory(layout, maxChars = 1800, now = Date.now(), opts = {}) {
  const trace = opts !== null && typeof opts === 'object' ? (opts.trace ?? null) : null
  const promoteAfter = Number(opts?.promoteAfter ?? 0)
  const facts = renderFacts(loadFacts(layout, { promoteAfter }).facts, { maxChars: LIMITS.factChars, now })
  const text = readTextIfExists(join(layout.persona, 'memory.md'))
  const marked = markStaleLines(text, now)
  const parts = []
  if (text.trim() !== '') {
    const budget = facts === '' ? maxChars : Math.max(200, maxChars - facts.length - 24)
    parts.push(clip(marked, budget))
  }
  if (facts !== '') {
    if (parts.length > 0) parts.push('')
    parts.push('## 我记下的事实（yunqi_remember）')
    parts.push(facts)
  }
  if (parts.length === 0) {
    if (trace !== null && typeof trace === 'object') {
      Object.assign(trace, { name: 'yunqi:memory', budget: maxChars, chars: 0, fullChars: 0 })
    }
    return ''
  }
  const full = parts.join('\n')
  const out = clip(full, maxChars)
  if (trace !== null && typeof trace === 'object') {
    // fullChars 记「素材原始长度」：分段预算已经把 memory 截过一次，最后这次
    // clip 往往没得可截；拿 full.length 判断就永远显示「没超预算」。
    Object.assign(trace, {
      name: 'yunqi:memory',
      budget: maxChars,
      chars: out.length,
      fullChars: Math.max(full.length, marked.length + facts.length),
    })
  }
  return out
}

function markStaleLines(text, now) {
  const staleMs = MEMORY_STALE_DAYS * 24 * 60 * 60 * 1000
  return text.split('\n').map((line) => {
    const match = /^- \((\d{4}-\d{2}-\d{2})\)/.exec(line)
    if (match === null) return line
    const age = now - Date.parse(`${match[1]}T00:00:00`)
    return age > staleMs ? `${line}（久未复核）` : line
  }).join('\n')
}
