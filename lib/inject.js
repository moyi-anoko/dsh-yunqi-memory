/**
 * 注入回执：这次注入了哪些段、各多少字、有没有因为预算被砍。
 *
 * 思路借自 dsh-nexus 的 injectionTruth（src/injection-truth.ts:93-163）：注入之后
 * 要能回答「这条为什么没进去」。但那边是「原子列表 + 逐条字节预算」，我们是
 * 「整块渲染」，所以回执只记「预算 vs 实际」，不假装知道每一条的去留。
 *
 * 规则：
 * - 只有真的发生截断才写一行；没截就是正常，不刷账本。
 * - 同一段 5 分钟内只记一次（每轮都注入，不节流会把 audit 写爆）。
 * - 回执不改变注入内容，写失败也不影响对话（调用方 try/catch）。
 */
import { appendJsonl } from './util.js'

const THROTTLE_MS = 5 * 60 * 1000
const lastWrite = new Map()

/**
 * @param {Object} layout 数据目录
 * @param {{name?:string,budget?:number,chars?:number,fullChars?:number}} trace 渲染时填的回执
 * @returns {boolean} 是否真的写了一行
 */
export function auditInject(layout, trace) {
  if (layout === null || typeof layout !== 'object' || trace === null || typeof trace !== 'object') return false
  const name = String(trace.name ?? '')
  const budget = Number(trace.budget ?? 0)
  const full = Number(trace.fullChars ?? 0)
  if (name === '' || budget <= 0 || full <= budget) return false

  const key = `${layout.audit}:${name}`
  const now = Date.now()
  const previous = lastWrite.get(key) ?? 0
  if (now - previous < THROTTLE_MS) return false
  lastWrite.set(key, now)

  appendJsonl(layout.audit, {
    schema: 1,
    type: 'inject',
    ts: now,
    name,
    budget,
    chars: Number(trace.chars ?? 0),
    dropped: Math.max(0, full - budget),
    reason: 'budget',
  })
  return true
}
