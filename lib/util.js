/** 小工具：截断、原子写、追加式 JSONL。只用 node 内置模块。 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 单个 JSONL 超过这个大小就归档换新文件（16 MiB）。 */
export const JSONL_ROTATE_BYTES = 16 * 1024 * 1024

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/** 规范化换行与首尾空白后截到 max 字符（不是字节）。 */
export function clip(text, max) {
  const value = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (max <= 0 || value.length <= max) return value
  return value.slice(0, max).trimEnd() + '…'
}

/** 压成一行，用于状态块这种不能换行的地方。 */
export function oneLine(text, max = 200) {
  return clip(String(text ?? '').replace(/\s+/g, ' '), max)
}

/**
 * append-only 账本写入。先看文件大小，超过 JSONL_ROTATE_BYTES 就改名归档再开新文件——
 * 归档不删除，任何一条旧记录都还能在 .bak 里找到。
 */
export function appendJsonl(file, row) {
  ensureDir(dirname(file))
  rotateIfTooLarge(file)
  appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8')
}

/** 文件不存在不是错误；只有确实超过阈值才轮转。 */
function rotateIfTooLarge(file) {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return
  }
  if (size > JSONL_ROTATE_BYTES) renameSync(file, `${file}.${Date.now()}.bak`)
}

/** 读整份 JSONL；坏行跳过，不因为一行坏掉整本账。 */
export function readJsonl(file) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* 坏行跳过：账本宁可少一行，也不能整本读不出来。 */
    }
  }
  return rows
}

export function readTextIfExists(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 原子写：先写 .tmp 再 rename，进程死在中间也不会留下半份状态。 */
export function writeAtomic(file, text) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

export function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex')
}

export function safeId(value) {
  const text = String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return text === '' ? 'unknown' : text
}

const pad = (n) => String(n).padStart(2, '0')

export function localDate(ms = Date.now()) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function localStamp(ms = Date.now()) {
  const d = new Date(ms)
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
