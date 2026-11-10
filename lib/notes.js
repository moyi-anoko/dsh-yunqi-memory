/**
 * 把工作区里已经写好的 markdown 日记/笔记喂进检索池。
 *
 * 不抓对话、不改原文件：读一遍，按标题和长度切块，写成 `episodes/diary.jsonl`，
 * 检索时用 `yunqi_recall({ channel: 'diary' })` 单独查。
 *
 * @typedef {Object} NoteRow
 * @property {number} schema
 * @property {string} id
 * @property {string} sid         `diary:<相对路径>`
 * @property {string} ws         固定 `diary`
 * @property {number} turn       块序号
 * @property {number} ts         文件 mtime
 * @property {string} user       块正文（带文件名与所在小标题）
 * @property {string} assistant  空
 * @property {Object} source     { channel:'diary', platform:'diary', path, title }
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sha1, writeAtomic } from './util.js'

const NOTE_LIMITS = { chunk: 1600, minChunk: 20, maxFileBytes: 2 * 1024 * 1024 }
const NOTE_EXTENSIONS = new Set(['.md', '.txt'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '表情包'])

/**
 * 列出一个目录下的笔记文件（递归，跳过隐藏目录和表情包目录）。
 * @param {string} root
 * @returns {string[]}
 */
export function listNoteFiles(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const dot = entry.name.lastIndexOf('.')
      if (dot < 0) continue
      if (!NOTE_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) continue
      out.push(full)
    }
  }
  walk(root, 0)
  return out.sort()
}

/**
 * 把一份 markdown 切成检索块：标题打断，超长按空行切。
 * @param {string} text
 * @param {string} fallbackTitle
 * @returns {{title:string, chunks:string[]}}
 */
export function splitNote(text, fallbackTitle) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const title = (lines.find((line) => /^#\s+\S/.test(line)) ?? `# ${fallbackTitle}`).replace(/^#\s+/, '').trim()
  const chunks = []
  let current = []
  let heading = ''
  const flush = () => {
    const body = current.join('\n').trim()
    current = []
    if (body.length < NOTE_LIMITS.minChunk) return
    const prefix = `【${title}】${heading === '' ? '' : ` ${heading}`}`
    chunks.push(`${prefix}\n${body}`.slice(0, NOTE_LIMITS.chunk + 200))
  }
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line)) {
      flush()
      heading = line.replace(/^#{1,6}\s+/, '').trim()
      current.push(line)
      continue
    }
    current.push(line)
    if (current.join('\n').length >= NOTE_LIMITS.chunk) flush()
  }
  flush()
  return { title, chunks }
}

/**
 * 导入一个目录下的所有笔记，整份重写 `episodes/diary.jsonl`。
 * @param {ReturnType<import('./ledger.js').layoutOf>} layout
 * @param {{dir:string, dryRun?:boolean}} options
 * @returns {{files:number, chunks:number, chars:number, written:boolean}}
 */
export function importNotes(layout, options) {
  const dir = String(options?.dir ?? '')
  if (dir === '') throw new Error('importNotes: dir 不能为空')
  const files = listNoteFiles(dir)
  const rows = []
  let chars = 0
  for (const file of files) {
    let stat
    try {
      stat = statSync(file)
    } catch {
      continue
    }
    if (stat.size > NOTE_LIMITS.maxFileBytes) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const rel = relative(dir, file)
    const { title, chunks } = splitNote(text, rel.replace(/\.(md|txt)$/i, ''))
    chunks.forEach((chunk, index) => {
      chars += chunk.length
      rows.push({
        schema: 1,
        id: `note-${sha1(`${rel}:${index}`).slice(0, 12)}`,
        sid: `diary:${rel}`,
        ws: 'diary',
        turn: index + 1,
        ts: Math.round(stat.mtimeMs),
        seqStart: null,
        seqEnd: null,
        user: chunk,
        assistant: '',
        reasoning: [],
        toolCalls: [],
        errors: [],
        todos: null,
        source: { channel: 'diary', platform: 'diary', path: rel, title },
      })
    })
  }
  if (options?.dryRun === true) return { files: files.length, chunks: rows.length, chars, written: false }
  const target = join(layout.episodes, 'diary.jsonl')
  writeAtomic(target, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length === 0 ? '' : '\n'))
  return { files: files.length, chunks: rows.length, chars, written: true }
}
