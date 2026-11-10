/**
 * 判断账本：记录「这条记忆被扫到 / 被真的用上 / 之后被纠正」。
 *
 * 这是全 22 个参考插件里都没有的那一格。它不改变记忆内容，只回答：
 *   - 这条被搜到过几次（surface，弱信号：搜到不代表有用）
 *   - 这条进过回答几次（cite，强信号：真的影响了判断）
 *   - 用了之后有没有被纠正（correct，负信号：可能是错的，也可能是时机不对）
 *
 * @typedef {Object} UsageRow
 * @property {number} schema
 * @property {'surface'|'cite'|'correct'} type
 * @property {string} episodeId
 * @property {string} sessionId
 * @property {number} ts
 * @property {string} [query]
 * @property {string} [note]
 *
 * @typedef {Object} JudgmentRow
 * @property {number} schema
 * @property {string} id
 * @property {number} ts
 * @property {string} kind
 * @property {string} episodeId
 * @property {string} sessionId
 * @property {string} summary
 */
import { statSync } from 'node:fs'
import { appendJsonl, readJsonl, sha1 } from './util.js'

export const JUDGMENT_SCHEMA = 1

const RECENT_CITE_MS = 4 * 60 * 60 * 1000

/** 按 mtime+size 缓存；文件没变就不重读。 */
let cache = { file: '', key: '', rows: [] }

export function loadUsage(layout) {
  const key = cacheKey(layout.usage)
  if (cache.file === layout.usage && cache.key === key) return cache.rows
  const rows = readJsonl(layout.usage)
  cache = { file: layout.usage, key, rows }
  return rows
}

function cacheKey(file) {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

/** 汇总成检索用的索引。cites/surfaces/corrections 都是 Map<episodeId, count>。 */
export function usageIndex(rows) {
  const cites = new Map()
  const surfaces = new Map()
  const corrections = new Map()
  const lastCite = new Map()
  for (const row of rows) {
    if (!row || typeof row.episodeId !== 'string') continue
    if (row.type === 'cite') {
      cites.set(row.episodeId, (cites.get(row.episodeId) ?? 0) + 1)
      lastCite.set(row.episodeId, Math.max(lastCite.get(row.episodeId) ?? 0, Number(row.ts ?? 0)))
      continue
    }
    if (row.type === 'surface') {
      surfaces.set(row.episodeId, (surfaces.get(row.episodeId) ?? 0) + 1)
      continue
    }
    if (row.type === 'correct') corrections.set(row.episodeId, (corrections.get(row.episodeId) ?? 0) + 1)
  }
  return { cites, surfaces, corrections, lastCite }
}

/** 记录一条判断。usage.jsonl 是数据，judgments.jsonl 是给人看的回执。 */
export function record(layout, row) {
  const ts = Number(row.ts ?? Date.now())
  const usage = {
    schema: JUDGMENT_SCHEMA,
    type: row.type,
    episodeId: String(row.episodeId ?? ''),
    sessionId: String(row.sessionId ?? ''),
    ts,
  }
  if (row.query) usage.query = String(row.query).slice(0, 200)
  if (row.note) usage.note = String(row.note).slice(0, 200)
  appendJsonl(layout.usage, usage)
  const judgment = {
    schema: JUDGMENT_SCHEMA,
    id: `jd-${sha1(`${row.type}:${row.episodeId}:${ts}:${usage.sessionId}`).slice(0, 12)}`,
    ts,
    kind: row.type,
    episodeId: usage.episodeId,
    sessionId: usage.sessionId,
    summary: summaryOf(row),
  }
  appendJsonl(layout.judgments, judgment)
  return judgment
}

function summaryOf(row) {
  if (row.type === 'surface') return `搜到但未引用：${row.query ?? ''}`
  if (row.type === 'cite') return `引用进回答：${row.query ?? ''}`
  return `使用后被纠正${row.note ? `：${row.note}` : ''}`
}

export function recordSurface(layout, input) {
  return record(layout, { type: 'surface', ...input })
}

export function recordCite(layout, input) {
  return record(layout, { type: 'cite', ...input })
}

export function recordCorrect(layout, input) {
  return record(layout, { type: 'correct', ...input })
}

/** 最近 4 小时内被引用过的条目：下一轮召回时降权，避免同一句话反复出现。 */
export function recentCitations(rows, now = Date.now()) {
  const recent = new Map()
  for (const row of rows) {
    if (row?.type !== 'cite' || typeof row.episodeId !== 'string') continue
    if (now - Number(row.ts ?? 0) <= RECENT_CITE_MS) recent.set(row.episodeId, Number(row.ts ?? 0))
  }
  return recent
}
