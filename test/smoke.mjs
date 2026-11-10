/**
 * 冒烟测试：用假 ctx / 假 session 跑一次完整的
 * 捕获 → 回合聚合 → 状态重写 → 检索 → 引用记账 → 纠正回填。
 *
 * 只碰临时目录，不读真实会话，不联网。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { layoutOf, workspaceKey } from '../lib/ledger.js'
import { readJsonl } from '../lib/util.js'
import { buildIndex, rehearseFactor, scoreIndex, search, tokenize } from '../lib/recall.js'
import { loadUsage } from '../lib/judge.js'
import { appendFact, factsFile, loadFacts } from '../lib/facts.js'
import { cleanUserText } from '../lib/source.js'

const dir = mkdtempSync(join(tmpdir(), 'yunqi-memory-'))
const config = { dir }
const layout = layoutOf(dir)

const sections = []
const contexts = []
const tools = new Map()
const handlers = new Map()
const ctx = {
  systemPrompt: {
    section: (item) => sections.push(item),
    context: (item) => contexts.push(item),
  },
  tools: { register: (tool) => tools.set(tool.name, tool) },
  on: (name, handler) => {
    const list = handlers.get(name) ?? []
    list.push(handler)
    handlers.set(name, list)
  },
  effect: () => {},
}

try {
  apply(ctx, config)
  assert.equal(sections.length, 3, '注册身份段、记忆段与政策段')
  assert.deepEqual(sections.map((item) => item.name), ['yunqi:identity', 'yunqi:memory', 'yunqi:policy'])
  assert.equal(contexts.length, 1, '注册一个每轮状态段')
  for (const tool of ['yunqi_recall', 'yunqi_remember', 'yunqi_persona']) {
    assert.ok(tools.has(tool), `注册工具 ${tool}`)
  }

  const events = [
    { seq: 1, time: 1_700_000_000_000, type: 'user/message', data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '帮我看看记忆插件该怎么结合' }] } } },
    { seq: 2, time: 1_700_000_001_000, type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '先想状态层' }, { type: 'text', text: '先做状态层，再做判断账本。' }] } } },
    { seq: 3, time: 1_700_000_002_000, type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'read', arguments: '{"path":"x"}' } },
    { seq: 4, time: 1_700_000_003_000, type: 'tool/result', data: { turn: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '文件内容' }], isError: false } } },
    { seq: 5, time: 1_700_000_004_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = {
    id: 'sess-1',
    header: { cwd: 'D:/work' },
    snapshotEvents: () => events,
    deriveEventMessage: (event) => event.data.message ?? null,
  }

  for (const event of events) for (const handler of handlers.get('session/event') ?? []) handler(session, event)

  const ws = workspaceKey('D:/work')
  const episodes = readJsonl(join(layout.episodes, `${ws}.jsonl`))
  assert.equal(episodes.length, 1, '一个回合产出一条 Episode')
  assert.equal(episodes[0].user, '帮我看看记忆插件该怎么结合')
  assert.equal(episodes[0].assistant, '先做状态层，再做判断账本。')
  assert.ok(episodes[0].reasoning.includes('先想状态层'), 'reasoning 保留')
  assert.equal(episodes[0].toolCalls.length, 1)
  assert.equal(episodes[0].toolCalls[0].result, '文件内容')

  const state = JSON.parse(readFileSync(join(layout.state, 'sess-1.json'), 'utf8'))
  assert.equal(state.turn, 1)
  assert.ok(state.lastConclusion.includes('状态层'))

  const hits = search(layout, { ws, query: '记忆插件 怎么结合', usage: loadUsage(layout) })
  assert.ok(hits.length >= 1, '能检索到刚写的回合')
  assert.equal(hits[0].id, episodes[0].id)

  const exec = { agent: { session } }
  const recallOut = await tools.get('yunqi_recall').execute({ query: '记忆插件 怎么结合' }, exec)
  assert.ok(recallOut.count >= 1)

  const recallCiteOut = await tools.get('yunqi_recall').execute({ query: '记忆插件 怎么结合', cite: true }, exec)
  assert.ok(recallCiteOut.count >= 1)

  const rememberOut = await tools.get('yunqi_remember').execute({ text: '主人偏好短句', tags: ['偏好'] }, exec)
  assert.equal(rememberOut.total, 1)

  // 写入四态：完全重复不写第二条（借 lingzhu md_cg/forgetting.py 的 DROP）。
  const dupOut = await tools.get('yunqi_remember').execute({ text: '主人偏好短句', tags: ['偏好'] }, exec)
  assert.equal(dupOut.state, 'DROP', '完全重复不进第二条')
  assert.equal(dupOut.id, rememberOut.id)
  assert.equal(dupOut.total, 1, '记忆库条数不变')

  const personaOut = await tools.get('yunqi_persona').execute(
    { action: 'propose', text: '先给状态再给结论', evidence: [episodes[0].id] },
    exec,
  )
  assert.equal(personaOut.ok, true)
  const listOut = await tools.get('yunqi_persona').execute({ action: 'list' }, exec)
  assert.equal(listOut.pending.length, 1, '提案待定，不会自动进人格')

  // 稳定核由模型自己写：重写后身份段立即变化，旧版进 history。
  await tools.get('yunqi_persona').execute({ action: 'rewrite', text: '# 云栖\n第一版' }, exec)
  assert.ok(sections[0].text().includes('第一版'), '身份段读到稳定核')
  await tools.get('yunqi_persona').execute({ action: 'rewrite', text: '# 云栖\n第二版' }, exec)
  assert.ok(sections[0].text().includes('第二版'))
  const history = readdirSync(join(layout.history))
  assert.ok(history.some((file) => file.startsWith('stable-')), '旧版进 history 备份')

  // 纠正：下一轮用户说「不对」，最近被引用的条目要记一次 correct。
  const turn2 = [
    { seq: 6, time: 1_700_000_005_000, type: 'user/message', data: { turn: 2, message: { role: 'user', content: [{ type: 'text', text: '不对，顺序反了，先做判断账本' }] } } },
    { seq: 7, time: 1_700_000_006_000, type: 'assistant/message', data: { turn: 2, message: { role: 'assistant', content: [{ type: 'text', text: '好，先做判断账本。' }] } } },
    { seq: 8, time: 1_700_000_007_000, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const session2 = { ...session, snapshotEvents: () => [...events, ...turn2] }
  for (const event of turn2) for (const handler of handlers.get('session/event') ?? []) handler(session2, event)
  const usage = readJsonl(layout.usage)
  assert.ok(usage.some((row) => row.type === 'correct'), '纠正回填进了账本')
  assert.equal(readJsonl(join(layout.episodes, `${ws}.jsonl`)).length, 2)
  assert.ok(readJsonl(layout.judgments).length >= 3, 'judgments 有可读回执')

  const audit = readJsonl(layout.audit)
  assert.equal(audit.filter((row) => row.type === 'turn').length, 2)

  // 上下文状态块拿得到最新一轮。
  const nowText = contexts[0].text({ agent: { session: session2 } })
  assert.ok(nowText.includes('判断账本'), '状态块反映最新回合')

  // 来源层：QQ 群消息剥掉信封、取说话人，并可按 channel 过滤。
  const qqEvents = [
    {
      seq: 10,
      time: 1_700_000_010_000,
      type: 'user/message',
      data: {
        turn: 1,
        source: { kind: 'plugin:dsh-onebot' },
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '[00:05 测试员(123456789)·成员][@我] <user_message qq="123456789" nickname="测试员"> 晚上总结群消息 </user_message>' },
          ],
        },
      },
    },
    { seq: 11, time: 1_700_000_011_000, type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好，每晚总结。' }] } } },
    { seq: 12, time: 1_700_000_012_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const qqSession = {
    id: 'onebot-group-100000001',
    header: { cwd: 'D:/work' },
    snapshotEvents: () => qqEvents,
    deriveEventMessage: (event) => event.data.message ?? null,
  }
  for (const event of qqEvents) for (const handler of handlers.get('session/event') ?? []) handler(qqSession, event)
  const all = readJsonl(join(layout.episodes, `${ws}.jsonl`))
  const qq = all.find((row) => row.sid === 'onebot-group-100000001')
  assert.equal(qq.source.channel, 'qq:group')
  assert.equal(qq.source.speakerName, '测试员')
  assert.equal(qq.source.peerId, '100000001')
  assert.equal(qq.user, '晚上总结群消息', 'QQ 信封被剥掉')

  const qqHits = search(layout, { ws, query: '晚上总结群消息', channel: 'qq:group', usage: loadUsage(layout) })
  assert.ok(qqHits.length >= 1)
  assert.equal(qqHits[0].channel, 'qq:group')
  assert.equal(search(layout, { ws, query: '晚上总结群消息', channel: 'harness', usage: loadUsage(layout) }).length, 0, 'channel 过滤生效')

  const recallOut2 = await tools.get('yunqi_recall').execute({ query: '晚上总结群消息', channel: 'qq:group' }, exec)
  assert.equal(recallOut2.hits[0].channel, 'qq:group')
  assert.ok(recallOut2.hits[0].source.includes('测试员'), '来源标签带说话人')

  // 引用嵌套信封（外层正文里还套着被引用消息）与截断收尾标签都不能漏。
  const nested = cleanUserText(
    '[00:05 测试员(123456789)·成员] <user_message qq="123456789" nickname="测试员"> 正文 </user_message\n[引用]尾巴\n</user_message>',
    { channel: 'qq:group', platform: 'qq' },
  )
  assert.ok(!/<\/?user_message/i.test(nested), '嵌套信封被剥干净')
  assert.ok(nested.startsWith('正文'), '正文保留')
  const truncated = cleanUserText(
    '<user_message qq="123456789" nickname="测试员">\n[图片:C:/x.jpg]\n</user_message',
    { channel: 'qq:private', platform: 'qq' },
  )
  assert.equal(truncated, '[图片:C:/x.jpg]', '截断收尾标签不吞正文')

  // ── 事实层：作废是写进存储的标记，不是删除 ──
  // 借鉴 sage-mem/lib/memory/arbitrate.js（正文不动、只追加作废标记）与
  // Hers_Life/dsh-ming-core-memory/lib/index.js:514-528（supersedes 落地方式）。
  const remember2 = await tools.get('yunqi_remember').execute(
    { text: '主人偏好长句', tags: ['偏好'], supersedes: [rememberOut.id] },
    exec,
  )
  assert.deepEqual(remember2.retired, [rememberOut.id], 'supersedes 返回被作废的 id')
  assert.equal(remember2.total, 1, '作废的旧事实不再计入生效条数')
  const factRows = readJsonl(join(layout.memory, 'facts.jsonl'))
  assert.equal(factRows.filter((row) => row.type === 'fact').length, 2, '正文只追加、不删')
  assert.ok(factRows.some((row) => row.type === 'retire' && row.target === rememberOut.id), '作废留痕')

  const factHits = search(layout, { ws, query: '主人偏好', channel: 'fact', usage: loadUsage(layout) })
  assert.ok(factHits.length >= 1, '事实能检索到')
  assert.equal(factHits[0].channel, 'fact')
  assert.ok(factHits[0].user.includes('长句'))
  assert.ok(!factHits.some((hit) => hit.id === rememberOut.id), '作废的事实检索不到')

  // 事实命中来自事实层，光看 sid 认不出是事实，要单独标「我记下的」。
  const factRecall = await tools.get('yunqi_recall').execute({ query: '主人偏好', channel: 'fact' }, exec)
  assert.equal(factRecall.hits[0].session, '我记下的')
  assert.ok(
    search(layout, { ws, query: '偏好长句', usage: loadUsage(layout) }).some((hit) => hit.channel === 'fact'),
    '默认检索池里也有事实',
  )

  // 事实要真的进上下文，不然 yunqi_remember 等于白记（改造前的真实缺陷）。
  const memText = sections[1].text()
  assert.ok(memText.includes('长句'), '事实进长期记忆段')
  assert.ok(!memText.includes('主人偏好短句'), '作废的事实不进上下文')

  // 注入回执：超预算时记一行「哪段被砍、砍了多少」（借 nexus injectionTruth 的问题意识）。
  writeFileSync(join(layout.persona, 'memory.md'), `- (2026-01-01) ${'很长的旧记忆'.repeat(400)}\n`)
  sections[1].text()
  const injectRows = readJsonl(layout.audit).filter((row) => row.type === 'inject')
  assert.equal(injectRows.length, 1, '注入被截断时写回执')
  assert.equal(injectRows[0].name, 'yunqi:memory')
  assert.ok(injectRows[0].dropped > 0, '回执带被砍的字数')

  // ── 检索：标识符分词 + 证据门槛 + 热度封顶 ──
  const identTokens = tokenize('lib/index.js 和 SAGE_MEM_DEBUG 的 0.9.14 版本')
  assert.ok(identTokens.includes('lib/index.js'), '路径整串保留')
  assert.ok(identTokens.includes('index'), '路径按分隔符切片')
  assert.ok(identTokens.includes('0.9.14'), '版本号不被拆成三个数字')

  // 只在少数词上碰到的旧事不该冒出来（借 sage-mem/lib/memory/bm25.js 的 evidence()）。
  const now = Date.now()
  const gateIndex = buildIndex([
    { id: 'strong', sid: 's', ws: 'w', ts: now, turn: 1, user: '记忆插件的门槛', assistant: '', source: { channel: 'harness' } },
    { id: 'weak', sid: 's', ws: 'w', ts: now, turn: 2, user: '插件里还有个别的功能', assistant: '', source: { channel: 'harness' } },
  ])
  const gateHits = scoreIndex(gateIndex, '记忆插件的门槛', { now })
  assert.equal(gateHits.length, 1, '证据不足的条目被门槛挡掉')
  assert.equal(gateHits[0].id, 'strong')

  // 会话来源标注：同一 query 打中两个会话，标签要能区分；自己的会话标「本会话」。
  // 只标注、不隔离——两条都要回来。
  const turn3 = [
    { seq: 20, time: 1_700_000_020_000, type: 'user/message', data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '记忆插件再加一个会话来源' }] } } },
    { seq: 21, time: 1_700_000_021_000, type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好，只标来源不隔离。' }] } } },
    { seq: 22, time: 1_700_000_022_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const otherSession = {
    id: 'c0ffee11-1111-2222-3333-444444444444',
    header: { cwd: 'D:/work' },
    snapshotEvents: () => turn3,
    deriveEventMessage: (event) => event.data.message ?? null,
  }
  for (const event of turn3) for (const handler of handlers.get('session/event') ?? []) handler(otherSession, event)

  const crossOut = await tools.get('yunqi_recall').execute({ query: '记忆插件', limit: 10 }, exec)
  const mine = crossOut.hits.find((hit) => hit.user.includes('记忆插件该怎么结合'))
  const other = crossOut.hits.find((hit) => hit.user.includes('再加一个会话来源'))
  assert.ok(mine && other, '同一 query 跨会话召回两条，不隔离')
  assert.equal(mine.session, '本会话')
  assert.equal(other.session, '会话 c0ffee11')

  // 热度不封顶会滚雪球（借 Hers_Life/dsh-ming-core-memory/lib/recall.js 的 GATE.cap）。
  assert.equal(rehearseFactor(1000, 1000), 1.6, '复述强化有上限')

  // 晋升台阶：promoteAfter 开着时，没有 evidence 的写入是 candidate，不进活事实。
  const gateDir = mkdtempSync(join(tmpdir(), 'yunqi-gate-'))
  try {
    const gateLayout = layoutOf(gateDir)
    appendFact(factsFile(gateLayout), { text: '还没有依据的一条', state: 'candidate', ts: 1 })
    appendFact(factsFile(gateLayout), { text: '有依据的一条', evidence: ['ep-1'], ts: 2 })
    assert.equal(loadFacts(gateLayout, { promoteAfter: 1 }).facts.length, 1, '候选不进活事实')
    assert.equal(loadFacts(gateLayout).facts.length, 2, '关掉晋升时行为不变')
  } finally {
    rmSync(gateDir, { recursive: true, force: true })
  }

  console.log('smoke ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
