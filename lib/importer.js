/**
 * 历史会话导入：把 DSH 已经写下的 session.v4.jsonl.zstd 变成可检索的 Episode。
 *
 * 只读原日志，不改、不搬、不复制原始事件；导入产物只有 episodes/*.jsonl 里
 * 带 imported:true 的条目。重复运行按 Episode id 去重，因此可以随时补跑。
 *
 * 日志是「一串 zstd 帧」而不是单个帧（每次落盘追加一帧），Node 的
 * zstdDecompressSync 只解第一帧，所以这里按魔数切片逐帧解压再拼起来。
 *
 * @typedef {Object} ImportStats
 * @property {number} files
 * @property {number} sessions
 * @property {number} episodes
 * @property {number} added
 * @property {number} skipped
 * @property {number} failed
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { appendEpisode, buildTurnFromEvents } from './episode.js'
import { readJsonl } from './util.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 逐帧解压一个追加式 zstd 日志；坏帧跳过，不中断整份文件。 */
export function decodeZstdFile(file) {
  const buffer = readFileSync(file)
  const starts = []
  for (let i = 0; i <= buffer.length - ZSTD_MAGIC.length; i += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, ZSTD_MAGIC.length, i, i + ZSTD_MAGIC.length) === 0) starts.push(i)
  }
  if (starts.length === 0) return ''
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(starts[k], end)).toString('utf8')
    } catch {
      // 压缩体内偶然出现魔数会造成假帧边界，丢掉这一帧比整份失败好。
    }
  }
  return text
}

export function parseEvents(text) {
  const events = []
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue
    try {
      const event = JSON.parse(line)
      if (event && typeof event.type === 'string') events.push(event)
    } catch {
      // 半行（日志正在写）或坏行：跳过。
    }
  }
  return events
}

/** 递归找 session.v4.jsonl(.zstd)。 */
export function findSessionLogs(sessionsDir) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (/^session\.v4\.jsonl(\.zstd)?$/.test(entry.name)) found.push(full)
    }
  }
  walk(sessionsDir, 0)
  return found
}

export function headerOf(events, file) {
  const header = events.find((event) => event.type === 'session') ?? {}
  const sessionId = String(header.id ?? '')
  const cwd = String(header.cwd ?? '')
  return { sessionId, cwd, createdAt: Number(header.createdAt ?? 0), file }
}

/**
 * 导入一个日志文件里的全部 turn。
 * @param {Object} layout
 * @param {string} file
 * @param {Object} [options]
 * @param {Set<string>} [options.seen] 已有 Episode id 集合
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.captureReasoning]
 * @returns {{episodes:number, added:number, skipped:number, sessionId:string, cwd:string, reason?:string}}
 */
export function importFile(layout, file, options = {}) {
  const events = parseEvents(decodeZstdFile(file))
  const header = headerOf(events, file)
  if (header.sessionId === '') {
    return { episodes: 0, added: 0, skipped: 0, sessionId: '', cwd: '', reason: 'no-session-header' }
  }
  const turns = new Set()
  for (const event of events) {
    const turn = Number(event?.data?.turn)
    if (Number.isFinite(turn)) turns.add(turn)
  }
  const stub = { id: header.sessionId, header: { cwd: header.cwd } }
  const seen = options.seen ?? new Set()
  let episodes = 0
  let added = 0
  let skipped = 0
  for (const turn of [...turns].sort((a, b) => a - b)) {
    const episode = buildTurnFromEvents(stub, events, turn, {
      captureReasoning: options.captureReasoning !== false,
    })
    if (!episode) continue
    episodes += 1
    if (seen.has(episode.id)) {
      skipped += 1
      continue
    }
    seen.add(episode.id)
    added += 1
    if (options.dryRun !== true) {
      appendEpisode(layout, { ...episode, imported: true })
    }
  }
  return { episodes, added, skipped, sessionId: header.sessionId, cwd: header.cwd }
}

/**
 * 导入整个 sessions 目录。
 * @param {Object} layout
 * @param {Object} [options]
 * @param {string} [options.dir] 默认 layout.sessions
 * @param {number} [options.limit] 最多处理几个文件
 * @param {number} [options.sinceDays] 只看这么多天内写过的
 * @param {string} [options.only] 路径包含这个子串才处理
 * @param {boolean} [options.dryRun]
 * @returns {ImportStats & {details:Array<Object>}}
 */
export function importSessions(layout, options = {}) {
  const dir = options.dir ?? layout.sessions
  const sinceDays = Number(options.sinceDays ?? 0)
  const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0
  let files = findSessionLogs(dir)
  if (typeof options.only === 'string' && options.only !== '') {
    files = files.filter((file) => file.includes(options.only))
  }
  if (cutoff > 0) {
    files = files.filter((file) => {
      try {
        return statSync(file).mtimeMs >= cutoff
      } catch {
        return false
      }
    })
  }
  files.sort((a, b) => {
    const ta = existsSync(a) ? statSync(a).mtimeMs : 0
    const tb = existsSync(b) ? statSync(b).mtimeMs : 0
    return tb - ta
  })
  if (Number(options.limit) > 0) files = files.slice(0, Number(options.limit))

  const stats = { files: files.length, sessions: 0, episodes: 0, added: 0, skipped: 0, failed: 0, details: [] }
  const seen = loadAllEpisodeIds(layout)
  for (const file of files) {
    try {
      const result = importFile(layout, file, { ...options, seen })
      stats.sessions += 1
      stats.episodes += result.episodes
      stats.added += result.added
      stats.skipped += result.skipped
      stats.details.push({ file, ...result })
    } catch (error) {
      stats.failed += 1
      stats.details.push({ file, error: String(error?.message ?? error) })
    }
  }
  return stats
}

/** episodes/ 下所有已存在的 Episode id。导入按 id 去重，所以可以随时补跑。 */
export function loadAllEpisodeIds(layout) {
  const ids = new Set()
  let entries = []
  try {
    entries = readdirSync(layout.episodes)
  } catch {
    return ids
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    for (const row of readJsonl(join(layout.episodes, name))) {
      if (typeof row?.id === 'string') ids.add(row.id)
    }
  }
  return ids
}
