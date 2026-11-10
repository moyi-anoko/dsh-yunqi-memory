#!/usr/bin/env node
/**
 * 把日记/笔记目录导入检索池。
 *
 * 用法：
 *   node tools/import-notes.mjs --dir=~/.dsh/whale-work/日记
 *   node tools/import-notes.mjs --dir=... --dry
 *
 * 只读原文件，整份重写 episodes/diary.jsonl；重复跑结果一致。
 */
import { join } from 'node:path'
import { layoutOf } from '../lib/ledger.js'
import { rootDir } from '../lib/paths.js'
import { importNotes } from '../lib/notes.js'

const arg = (name) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`))
  return hit === undefined ? '' : hit.slice(name.length + 3)
}

const dir = arg('dir') || join(process.cwd(), '日记')
const dryRun = process.argv.includes('--dry')
const layout = layoutOf(rootDir({}))
const result = importNotes(layout, { dir, dryRun })
console.log(JSON.stringify({ dir, dryRun, ...result }))
