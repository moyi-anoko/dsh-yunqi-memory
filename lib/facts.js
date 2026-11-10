/**
 * 事实层：yunqi_remember 写下的跨会话事实。
 *
 * 为什么单独一层：事实会过期（地址改了、偏好变了、设备换了）。只追加的账本如果只会
 * 往后摞，迟早同时躺着两条互相矛盾、分不清谁新的话——而模型分不清就会两头都信。
 *
 * 两条做法借自外部实现（只读源码，未运行）：
 *   - sage-mem/lib/memory/arbitrate.js：作废是**写进存储的事实**，不是旁路索引；
 *     正文一个字节都不改，只追加标记。
 *   - Hers_Life/dsh-ming-core-memory/lib/index.js:514-528：填了 supersedes 就把旧条目
 *     置 superseded，正文不动，另写一行审计。
 *
 * 落到本插件：facts.jsonl 仍然只追加，新增两类行——
 *   { type: 'fact',   id, text, tags, sessionId, ws, ts }
 *   { type: 'retire', target, byId, ts, note }
 * 旧版本写的行没有 type（只有 id/text/tags），按 fact 读，不迁移、不改写。
 */
import { join } from 'node:path'
import { appendJsonl, clip, readJsonl, sha1 } from './util.js'
import { loadUsage, usageIndex } from './judge.js'

export const FACT_SCHEMA = 1

const LIMITS = {
  text: 400,
  maxTags: 6,
  tag: 40,
  maxSupersedes: 8,
  /** 「凭什么记这条」最多留几条 Episode id。 */
  maxEvidence: 8,
  /** 注入时每条最多这么长：事实原文可以更全，进上下文的是提要。 */
  renderLine: 200,
  renderChars: 800,
}

/** 字面重合度到这两个阈值就落对应裁决（没有 embedding，只判得了字面）。 */
const DUP_DROP = 0.92
const DUP_MERGE = 0.6

export function factsFile(layout) {
  return join(layout.memory, 'facts.jsonl')
}

/** 行的类型。老行没有 type 字段，但有 text 就是事实。 */
function rowType(row) {
  if (row === null || typeof row !== 'object') return ''
  if (row.type === 'fact' || row.type === 'retire') return row.type
  if (typeof row.text === 'string' && typeof row.id === 'string') return 'fact'
  return ''
}

/**
 * 折叠账本：按行序读，retire 让目标作废。
 *
 * 顺序很重要——先写新事实、再写 retire，中间有一瞬间旧新并存；
 * 先 retire 后写新事实，读的人任何时候都只会看到一条生效的。
 *
 * @returns {{facts: Array<Object>, retired: Set<string>, all: Map<string,Object>}}
 */
export function foldFacts(rows) {
  const facts = new Map()
  const retired = new Set()
  const order = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const type = rowType(row)
    if (type === 'fact') {
      if (!facts.has(row.id)) order.push(row.id)
      facts.set(row.id, row)
      continue
    }
    if (type === 'retire') {
      const target = String(row.target ?? '')
      if (target !== '') retired.add(target)
    }
  }
  const active = order.filter((id) => !retired.has(id)).map((id) => facts.get(id))
  return { facts: active, retired, all: facts }
}

/**
 * 读事实账本。坏行由 readJsonl 跳过，这里不再兜。
 *
 * promoteAfter>0 时，state='candidate' 的事实只有被 cite 够次数才当活事实用；
 * 关着（默认 0）就只看 retire 标记，和改造前行为一致。
 */
export function loadFacts(layout, options = {}) {
  const folded = foldFacts(readJsonl(factsFile(layout)))
  const promoteAfter = Number(options?.promoteAfter ?? 0)
  if (!(promoteAfter > 0)) return folded
  const cites = options?.cites instanceof Map ? options.cites : usageIndex(loadUsage(layout)).cites
  const facts = folded.facts.filter((fact) => fact.state !== 'candidate' || (cites.get(fact.id) ?? 0) >= promoteAfter)
  return { ...folded, facts }
}

/** 去掉标点与空白，只留可比较的字。 */
function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function bigrams(text) {
  const set = new Set()
  for (let index = 0; index + 1 < text.length; index += 1) set.add(text.slice(index, index + 2))
  return set
}

/** 字面重合度（字符二元组 Jaccard）。不做语义判断，够不着的交给模型。 */
export function similarity(a, b) {
  const left = bigrams(normalizeText(a))
  const right = bigrams(normalizeText(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const item of left) if (right.has(item)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * 写入前判定（结构借 lingzhu md_cg/forgetting.py:261-420 的 assess，只保留我们付得起的一半）。
 *
 * 三问四态：全新 → ACCEPT；已存在 → DROP（不写第二条）；半重复 → MERGE（写新的、作废旧条）。
 * DEFER 需要「半重复但不该合并」的语义判断，字面判不了，这里明确不做——不假装有第四态。
 */
export function assessFact(facts, text) {
  const norm = normalizeText(text)
  if (norm === '') return { state: 'DROP', reason: 'empty' }
  let best = null
  for (const fact of Array.isArray(facts) ? facts : []) {
    const score = similarity(norm, fact?.text)
    if (best === null || score > best.similarity) best = { fact, similarity: score }
  }
  if (best === null) return { state: 'ACCEPT' }
  if (best.similarity >= DUP_DROP) return { state: 'DROP', duplicateOf: best.fact.id, similarity: best.similarity }
  if (best.similarity >= DUP_MERGE) return { state: 'MERGE', mergeInto: best.fact.id, similarity: best.similarity }
  return { state: 'ACCEPT', nearest: best.fact.id, similarity: best.similarity }
}

/**
 * 写一条事实。带 supersedes 时先把旧条目标成作废，再写新条目。
 *
 * evidence 是「凭什么记这条」的 Episode id 列表；state 为 candidate 时表示
 * 证据还没够，只进检索不进上下文（见 loadFacts 的 promoteAfter）。
 *
 * @param {string} file
 * @param {{text:string, tags?:string[], supersedes?:string[], evidence?:string[], state?:string, sessionId?:string, ws?:string, ts?:number}} input
 * @returns {{fact:Object, retired:string[]}}
 */
export function appendFact(file, input) {
  const text = clip(String(input?.text ?? ''), LIMITS.text)
  if (text === '') throw new Error('事实不能为空')
  const ts = Number(input?.ts ?? Date.now())
  const id = 'fact-' + sha1(text + ':' + ts).slice(0, 12)
  const fact = {
    schema: FACT_SCHEMA,
    type: 'fact',
    id,
    text,
    tags: (Array.isArray(input?.tags) ? input.tags : [])
      .map((tag) => clip(String(tag), LIMITS.tag))
      .filter((tag) => tag !== '')
      .slice(0, LIMITS.maxTags),
    evidence: (Array.isArray(input?.evidence) ? input.evidence : [])
      .filter((item) => typeof item === 'string' && item !== '')
      .slice(0, LIMITS.maxEvidence),
    state: input?.state === 'candidate' ? 'candidate' : 'active',
    sessionId: String(input?.sessionId ?? ''),
    ws: String(input?.ws ?? ''),
    ts,
  }
  const targets = (Array.isArray(input?.supersedes) ? input.supersedes : [])
    .filter((target) => typeof target === 'string' && target !== '')
    .slice(0, LIMITS.maxSupersedes)
  const retired = []
  for (const target of targets) {
    if (target === id) continue
    appendJsonl(file, { schema: FACT_SCHEMA, type: 'retire', target, byId: id, ts, note: clip(text, 80) })
    retired.push(target)
  }
  appendJsonl(file, fact)
  return { fact, retired }
}

/** 撤回一条事实（用户说「这条别记了」）。只追加标记，不删原文。 */
export function retireFact(file, input) {
  const target = String(input?.id ?? '')
  if (target === '') throw new Error('缺少要作废的事实 id')
  const ts = Number(input?.ts ?? Date.now())
  appendJsonl(file, { schema: FACT_SCHEMA, type: 'retire', target, byId: String(input?.byId ?? ''), ts, note: clip(String(input?.note ?? ''), 80) });
  return target;
}

/** 超过这么多天没再确认的事实，注入时标「久未复核」。 */
export const FACT_STALE_DAYS = 45;

/**
 * 渲染成活事实清单，给长期记忆段用。
 * 每条带日期；旧的加「久未复核」——不静默当成今天的事实。
 */
export function renderFacts(facts, options) {
  const opts = options && typeof options === 'object' ? options : {}
  const maxChars = Number(opts.maxChars ?? LIMITS.renderChars)
  const now = Number(opts.now ?? Date.now())
  if (!Array.isArray(facts) || facts.length === 0) return ''
  const staleMs = FACT_STALE_DAYS * 24 * 60 * 60 * 1000
  const lines = []
  let size = 0
  for (const fact of facts) {
    const ts = Number(fact?.ts ?? 0)
    const mark = ts > 0 && now - ts > staleMs ? '（久未复核）' : ''
    const line = '- (' + stampDate(ts) + ') ' + clip(fact?.text, LIMITS.renderLine) + mark
    if (size + line.length + 1 > maxChars && lines.length > 0) break
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n');
}

function stampDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0000-00-00'
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
