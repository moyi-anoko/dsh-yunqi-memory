/**
 * 检索：BM25 + 幂律遗忘 + 复述强化 + 纠正惩罚。
 *
 * 打分形状：
 *   score = bm25 × recency × rehearse × (1 + phraseBonus) × correctPenalty
 * 对应三条判断：
 *   1) 时间过去越久越淡（幂律，不是指数——指数会掉得太快）；
 *   2) 真被想起来过（cite）比只是被扫到（surface）权重高 3 倍；
 *   3) 被纠正过的记忆要降权，别让它反复出现在错误的地方。
 *
 * 另外两道闸是后加的，借鉴外部实现（只读源码，未运行）：
 *   - 证据门槛 evidenceOf：借 sage-mem/lib/memory/bm25.js 的 evidence()。
 *     BM25 对任何问题都非零——问「天气」，讲「天会黑」的旧事也能得分。
 *     所以要另算一份「命中了多少真正存在的查询词」，不够就不让进结果。
 *   - 复述强化封顶：借 Hers_Life/dsh-ming-core-memory/lib/recall.js 的 GATE.cap。
 *     热度不封顶会滚雪球，被查过三次的旧事永远压住新事。
 *
 * @typedef {Object} RecallHit
 * @property {string} id
 * @property {string} sid
 * @property {string} ws
 * @property {number} ts
 * @property {number} turn
 * @property {number} score
 * @property {string} user
 * @property {string} assistant
 * @property {string} channel
 * @property {string} [speakerName]
 * @property {number|null} seqStart
 * @property {number|null} seqEnd
 */
import { statSync } from 'node:fs'
import { readJsonl } from './util.js'
import { episodeFile } from './episode.js'
import { usageIndex } from './judge.js'
import { loadFacts } from './facts.js'

export const BM25 = { k1: 1.2, b: 0.75 }

const RECENCY = { floor: 0.05, scaleDays: 0.5, power: -0.8 }
const REHEARSE = { strong: 0.3, weak: 0.1, cap: 1.6 }
const CORRECTION = { penalty: 0.7 }
const PHRASE = { bonus: 0.6, minChars: 4 }
const RECENT_CITE_MS = 4 * 60 * 60 * 1000
const RECENT_CITE_DEMOTE = 0.35
const HIT_TEXT_CHARS = 240

/**
 * 证据门槛。ratio 是「命中的查询权重 / 库里存在的查询权重」；
 * sum 是绝对权重和；rarestDf 是命中词里最小的 df；run 是文档里连续命中的词元数。
 * 四条满足一条就放行——单看 ratio 会放过一堆只在虚词上重合的短句。
 */
export const EVIDENCE = { minRatio: 0.34, minSum: 1.8, minRareDf: 1, minRun: 3, fallback: 0.3 }

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/
const LATIN_RE = /[a-z0-9_]+/g
/** 带分隔符的标识符：路径、常量名、版本号。整串保留，再切出 ≥2 的片段。 */
const IDENT_RE = /[a-z0-9_][a-z0-9_.\\/:@-]*[a-z0-9_]/g
const IDENT_SPLIT_RE = /[^a-z0-9_]+/
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 中英混排分词：中文取二元组（2 字以上）并保留 6 字以内的整段，英文取词。
 * 标识符（lib/index.js、SAGE_MEM_DEBUG、0.9.14）整串保留 + 按分隔符切开，
 * 不然「0.9.14」会被拆成 0、9、14 三个没意义的词。
 */
export function tokenize(text) {
  const source = String(text ?? '').toLowerCase()
  const tokens = []
  let run = ''
  for (const ch of source) {
    if (CJK_RE.test(ch)) {
      run += ch
      continue
    }
    flushRun(run, tokens)
    run = ''
  }
  flushRun(run, tokens)
  for (const word of source.match(LATIN_RE) ?? []) {
    if (word.length >= 2) tokens.push(word)
  }
  for (const ident of source.match(IDENT_RE) ?? []) {
    if (ident.length >= 2) tokens.push(ident)
    for (const piece of ident.split(IDENT_SPLIT_RE)) {
      if (piece.length >= 2 && piece !== ident) tokens.push(piece)
    }
  }
  return tokens
}

function flushRun(run, tokens) {
  if (run === '') return
  if (run.length === 1) {
    tokens.push(run)
    return
  }
  for (let i = 0; i + 2 <= run.length; i += 1) tokens.push(run.slice(i, i + 2))
  if (run.length <= 6) tokens.push(run)
}

function termFrequency(tokens) {
  const tf = new Map()
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
  return tf
}

/** 建内存索引。工作区池由 workspaceIndex 按文件指纹缓存，日记池另缓。 */
export function buildIndex(episodes) {
  const docs = []
  const df = new Map()
  let totalLength = 0
  for (const episode of episodes) {
    const tokens = tokenize(`${episode.user ?? ''}\n${episode.assistant ?? ''}`)
    const tf = termFrequency(tokens)
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
    docs.push({ episode, tokens, tf, length: tokens.length })
    totalLength += tokens.length
  }
  return {
    docs,
    df,
    n: docs.length,
    avgLength: docs.length === 0 ? 0 : totalLength / docs.length,
  }
}

/** 幂律遗忘：ageDays 越大越小，但有下限，旧事仍可被特意召回。 */
export function recencyOf(ts, now) {
  const ageDays = Math.max(0, (now - Number(ts ?? 0)) / DAY_MS)
  const value = Math.pow(1 + ageDays / RECENCY.scaleDays, RECENCY.power)
  return Math.max(RECENCY.floor, value)
}

/** 真被想起来过（strong）比只是字面像（weak）更重要；封顶防滚雪球。 */
export function rehearseFactor(strong, weak) {
  const raw = 1 + REHEARSE.strong * Math.log(1 + strong) + REHEARSE.weak * Math.log(1 + weak)
  return Math.min(REHEARSE.cap, raw)
}

function idfOf(df, n) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5))
}

function bm25Of(doc, queryTokens, index) {
  const unique = [...new Set(queryTokens)]
  let score = 0
  for (const token of unique) {
    const tf = doc.tf.get(token) ?? 0
    if (tf === 0) continue
    const df = index.df.get(token) ?? 0
    const norm = BM25.k1 * (1 - BM25.b + BM25.b * (doc.length / (index.avgLength || 1)))
    score += idfOf(df, index.n) * ((tf * (BM25.k1 + 1)) / (tf + norm))
  }
  return score
}

/**
 * 一条文档手里到底有多少证据（借 sage-mem 的 evidence 思路）。
 * 关键点：df=0 的查询词不进分母——库里根本没有这个词，不能拿它来稀释证据。
 * @returns {{matched:number, ratio:number, sum:number, rarestDf:number, run:number}}
 */
export function evidenceOf(doc, queryTokens, index) {
  const unique = [...new Set(queryTokens)]
  let docWeight = 0
  let queryWeight = 0
  let matched = 0
  let rarestDf = Infinity
  const querySet = new Set(unique)
  for (const token of unique) {
    const df = index.df.get(token) ?? 0
    const weight = idfOf(df, index.n)
    if ((doc.tf.get(token) ?? 0) > 0) {
      matched += 1
      docWeight += weight
      rarestDf = Math.min(rarestDf, df)
    }
    if (df > 0) queryWeight += weight
  }
  return {
    matched,
    ratio: queryWeight > 0 ? docWeight / queryWeight : 0,
    sum: docWeight,
    rarestDf: rarestDf === Infinity ? 0 : rarestDf,
    run: longestRun(doc.tokens, querySet),
  };
}

/** 文档里连续命中查询词元的最长一段。治跨词边界的假词元（问天气命中「天会」）。 */
function longestRun(tokens, querySet) {
  let run = 0
  let best = 0
  for (const token of tokens) {
    if (querySet.has(token)) {
      run += 1
      if (run > best) best = run
    } else {
      run = 0
    }
  }
  return best;
}

function passesEvidence(ev) {
  if (ev.matched === 0) return false
  if (ev.run >= EVIDENCE.minRun) return true
  if (ev.rarestDf <= EVIDENCE.minRareDf && ev.matched >= 2) return true
  return ev.ratio >= EVIDENCE.minRatio && ev.sum >= EVIDENCE.minSum
}

function normaliseForPhrase(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, '')
}

/**
 * 对已建索引打分。
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {{now?:number, usage?:ReturnType<typeof usageIndex>, limit?:number, channel?:string}} [options]
 * @returns {RecallHit[]}
 */
export function scoreIndex(index, query, options = {}) {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0 || index.n === 0) return []
  const now = options.now ?? Date.now()
  const usage = options.usage ?? usageIndex([])
  const limit = options.limit ?? 5
  const phrase = normaliseForPhrase(query)
  const wantedChannel = String(options.channel ?? '')
  const candidates = []
  for (const doc of index.docs) {
    if (wantedChannel !== '' && (doc.episode.source?.channel ?? 'unknown') !== wantedChannel) continue
    const base = bm25Of(doc, queryTokens, index)
    if (base <= 0) continue
    const episode = doc.episode
    const strong = usage.cites.get(episode.id) ?? 0
    const weak = usage.surfaces.get(episode.id) ?? 0
    const corrected = usage.corrections.get(episode.id) ?? 0
    const lastCite = usage.lastCite.get(episode.id) ?? 0
    const phraseHit =
      phrase.length >= PHRASE.minChars &&
      normaliseForPhrase(`${episode.user ?? ''}${episode.assistant ?? ''}`).includes(phrase)
    const recent = now - lastCite < RECENT_CITE_MS
    const score =
      base *
      recencyOf(episode.ts, now) *
      rehearseFactor(strong, weak) *
      (1 + (phraseHit ? PHRASE.bonus : 0)) *
      (1 / (1 + CORRECTION.penalty * corrected)) *
      (recent ? RECENT_CITE_DEMOTE : 1)
    candidates.push({
      base,
      evidence: evidenceOf(doc, queryTokens, index),
      hit: {
        id: episode.id,
        sid: episode.sid,
        ws: episode.ws,
        ts: episode.ts,
        turn: episode.turn,
        score,
        user: String(episode.user ?? '').slice(0, HIT_TEXT_CHARS),
        assistant: String(episode.assistant ?? '').slice(0, HIT_TEXT_CHARS),
        channel: episode.source?.channel ?? 'unknown',
        speakerName: episode.source?.speakerName ?? '',
        seqStart: episode.seqStart ?? null,
        seqEnd: episode.seqEnd ?? null,
      },
    });
  }
  // 证据不够的直接扔；但若整批都不够（短查询、生僻词），留下最像的那几个，
  // 否则用户会得到「什么都没查到」——那比给出一个弱结果更糟。
  const best = candidates.reduce((max, item) => Math.max(max, item.base), 0)
  const kept = candidates.filter((item) => passesEvidence(item.evidence) || item.base >= best * EVIDENCE.fallback)
  kept.sort((a, b) => b.hit.score - a.hit.score)
  return kept.slice(0, limit).map((item) => item.hit)
}

function fileStamp(file) {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

function workspaceStamp(layout, spaces) {
  return spaces.map((space) => `${space}@${fileStamp(episodeFile(layout, space))}`).join('|')
}

let workspaceCache = { key: '', index: null }

/** 工作区池（本工作区 + shared，或全量）按文件指纹缓存，避免每次检索重扫全库。 */
function workspaceIndex(layout, spaces) {
  const key = workspaceStamp(layout, spaces)
  if (workspaceCache.key === key) return workspaceCache.index
  const byId = new Map()
  for (const space of spaces) {
    for (const episode of readJsonl(episodeFile(layout, space))) {
      if (episode && typeof episode.id === 'string' && !byId.has(episode.id)) byId.set(episode.id, episode)
    }
  }
  const index = buildIndex([...byId.values()])
  workspaceCache = { key, index }
  return index;
}

/** 事实层变成伪 Episode 进同一个索引：一条事实就是一句话，user 位放正文。 */
function factEpisodes(layout) {
  return loadFacts(layout).facts.map((fact) => ({
    id: fact.id,
    sid: fact.sessionId ?? '',
    ws: fact.ws || 'shared',
    ts: fact.ts,
    turn: 0,
    user: String(fact.text ?? ''),
    assistant: '',
    source: { channel: 'fact' },
    seqStart: null,
    seqEnd: null,
  }));
}

let factCache = { key: '', index: null }

function factsIndex(layout) {
  const key = fileStamp(factsFileOf(layout));
  if (factCache.key !== key) factCache = { key, index: buildIndex(factEpisodes(layout)) }
  return factCache.index;
}

function factsFileOf(layout) {
  return `${layout.memory}/facts.jsonl`;
}

/**
 * 从磁盘检索。默认只在本工作区 + shared 池里找；`crossWorkspace:true` 时全量。
 * channel='fact' 时只查事实层。
 * @returns {RecallHit[]}
 */
export function search(layout, options) {
  const query = String(options?.query ?? '')
  if (query.trim() === '') return []
  const ws = String(options?.ws ?? 'shared')
  const wantedChannel = String(options?.channel ?? '')
  const rows = Array.isArray(options?.usage) ? options.usage : readJsonl(layout.usage)
  const scoreOptions = {
    now: options?.now,
    usage: usageIndex(rows),
    limit: options?.limit ?? 5,
    channel: options?.channel,
  }
  // 日记单独一个池子，只在明确要查日记时读，避免每轮检索都拖着一堆笔记。
  if (wantedChannel === 'diary') return scoreIndex(diaryIndex(layout), query, scoreOptions)
  // 只要事实时不必扫对话库。
  if (wantedChannel === 'fact') return scoreIndex(factsIndex(layout), query, scoreOptions)
  const spaces = options?.crossWorkspace === true ? listWorkspaces(layout) : [ws, 'shared']
  return scoreIndex(mergedIndex(layout, spaces), query, scoreOptions)
}

let mergedCache = { key: '', index: null }

/**
 * 对话 + 事实合成一个池子再打分。合成结果也按指纹缓存——
 * 否则每次检索都要把整库重新分词一遍，缓存等于没做。
 */
function mergedIndex(layout, spaces) {
  const key = workspaceStamp(layout, spaces) + '#' + fileStamp(factsFileOf(layout))
  if (mergedCache.key === key) return mergedCache.index
  const episodes = [...workspaceIndex(layout, spaces).docs.map((doc) => doc.episode), ...factEpisodes(layout)]
  const index = buildIndex(episodes)
  mergedCache = { key, index }
  return index
}

let diaryCache = { key: '', index: null }

/** 日记池按文件 mtime+size 缓存，导入后第一次查询才建索引。 */
function diaryIndex(layout) {
  const file = episodeFile(layout, 'diary')
  try {
    const stat = statSync(file)
    const key = `${stat.mtimeMs}:${stat.size}`
    if (diaryCache.key !== key) diaryCache = { key, index: buildIndex(readJsonl(file)) }
  } catch {
    return buildIndex([])
  }
  return diaryCache.index;
}

function listWorkspaces(layout) {
  return [...new Set(readJsonl(layout.audit).map((row) => row?.ws).filter((ws) => typeof ws === 'string' && ws !== ''))]
}
