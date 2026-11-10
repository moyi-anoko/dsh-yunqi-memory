#!/usr/bin/env node
/**
 * 一次性导入历史会话：
 *   node tools/import-sessions.mjs                 # 全部导入（可反复跑，按 id 去重）
 *   node tools/import-sessions.mjs --dry           # 只统计，不写
 *   node tools/import-sessions.mjs --since-days=7  # 只导入最近 7 天写过的
 *   node tools/import-sessions.mjs --only=whale    # 只导入路径含 whale 的
 *   node tools/import-sessions.mjs --limit=5       # 最多 5 个日志文件
 */
import { join } from 'node:path'
import { layoutOf } from '../lib/ledger.js'
import { dshHome, rootDir } from '../lib/paths.js'
import { importSessions } from '../lib/importer.js'

const options = {}
for (const raw of process.argv.slice(2)) {
  if (raw === '--dry') {
    options.dryRun = true
    continue
  }
  const match = /^--([a-z-]+)=(.+)$/.exec(raw)
  if (!match) continue
  const key = match[1]
  const value = match[2]
  if (key === 'limit') options.limit = Number(value)
  else if (key === 'since-days') options.sinceDays = Number(value)
  else if (key === 'only') options.only = value
  else if (key === 'dir') options.dir = value
}

const layout = layoutOf(rootDir({}))
const sourceDir = options.dir ?? join(dshHome(), 'sessions')
const stats = importSessions(layout, { ...options, dir: sourceDir })
const summary = {
  dir: sourceDir,
  dryRun: options.dryRun === true,
  files: stats.files,
  sessions: stats.sessions,
  episodes: stats.episodes,
  added: stats.added,
  skipped: stats.skipped,
  failed: stats.failed,
}
console.log(JSON.stringify(summary))
const interesting = stats.details.filter((row) => row.episodes > 0 || row.error).slice(0, 12)
for (const row of interesting) {
  const name = row.file.replace(sourceDir + '\\', '')
  console.log(`${name} | episodes=${row.episodes} added=${row.added} skipped=${row.skipped}${row.error ? ` error=${row.error}` : ''}`)
}
