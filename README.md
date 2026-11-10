# dsh-yunqi-memory

给这条鱼用的记忆骨架：**状态层 + 判断账本 + 可回原文 + 受控人格**。

不是第四个记忆库。它借鉴了 22 个参考插件的形状，只补三件它们都没有当一等对象的东西：

1. **状态**（每轮重写）——现在在做什么、上次结论、未完成。压缩把历史换掉之后，鱼还知道自己在干什么。
2. **判断账本**（三列）——这条被搜到过几次 / 真的进过回答几次 / 用完之后被纠正过几次。让「值不值得留」有证据，而不是靠猜。
3. **受控成长**——AI 可以写成长提案，但只有人明确采纳的才进上下文；旧版本留在 decisions.jsonl。

## 注入什么（每轮只有五样）

| 内容 | 位置 | 大小 |
| --- | --- | --- |
| 身份块（`persona/stable.md` + 已采纳成长） | `systemPrompt.section` `yunqi:identity` | 稳定，≤ 2400 字 |
| 长期记忆摘录（`persona/memory.md` + `memory/facts.jsonl` 的事实层） | `systemPrompt.section` `yunqi:memory` | 稳定，≤ 1800 字（事实独占 ≤800 字） |
| 使用政策 | `systemPrompt.section` `yunqi:policy` | 固定五行 |
| 当前状态 | `systemPrompt.context` `yunqi:now` | 每轮变，≤ 700 字 |
| 旧事细节 | 不进上下文 | 模型用 `yunqi_recall` 按需查 |

身份块由本插件自己维护：稳定核 `persona/stable.md` 由模型写（`yunqi_persona action=rewrite`），
每次重写都把旧版存进 `persona/history/`，主人随时可以改。已采纳的成长追加在稳定核后面。
`identityInject: false` 才会关掉身份块。

`persona/memory.md` 是长期记忆摘录，原来由 `dsh-soul-md` 的 `global.md` 提供；soul-md 已从本机移除，
内容迁到这里（原文归档在 `persona/history/soul-md-global-20261109.md`）。

稳定内容进 section、易变内容进 context，是为了不破坏宿主的前缀缓存。

## 工具

| 工具 | 作用 |
| --- | --- |
| `yunqi_recall` | 按线索检索过去的回合，返回原文片段 + `episodeId`，并标注会话来源（「本会话 / 会话 xxxxxxxx / QQ群 xxx」）；每条结果记一次 surface。`channel` 可过滤：`any`（默认）/ `harness` / `qq:group` / `qq:private` / `injected` / `diary` / `fact`；传 `cite: true` 把第一条记为「真进了回答」 |
| `yunqi_remember` | 写一条跨会话事实（只追加）。写入前先查重：完全重复不写第二条、半重复合并并作废旧条（开关 `writeGate`）；`evidence: [episodeId]` 记「凭什么记这条」，配 `promoteAfter > 0` 时无依据的写入只是候选、不进上下文。旧事实说错了传 `supersedes: [旧 id]`：旧条目被标作废、正文不动 |
| `yunqi_persona` | `rewrite` 写稳定核（旧版自动进 `persona/history/`）；`list` / `propose` / `accept` / `reject` 管理成长提案 |

## 消息来源

每条 Episode 带 `source`，检索结果里显示成 `QQ群 · 名字` / `QQ私聊 · 名字` / `DSH` / `注入`。
检索**不按会话隔离**：所有会话共用一个池子，结果只标注来源（「本会话 / 会话 xxxxxxxx / QQ群 xxx / QQ私聊 / B站鲸鱼 / 日记 / 我记下的」），不裁剪别的会话。

| channel | 含义 | 判定依据 |
| --- | --- | --- |
| `harness` | DSH 界面里人直接说的话 | `source.kind` 缺省或 `user` |
| `qq:group` | QQ 群消息 | 会话名 `onebot-group-<群号>`，或正文带 `·成员/管理员/群主` |
| `qq:private` | QQ 私聊 | 会话名 `onebot-private-<QQ号>`，或只有 `<user_message>` 信封 |
| `injected` | runtime-context / skill-catalog / time-context 等注入块 | 其余 `source.kind` |
| `fact` | 事实层，检索结果里显示成「我记下的」 | `memory/facts.jsonl` 里生效的事实 |

说话人取 `<user_message qq="…" nickname="…">`；`user` 字段存的是剥掉信封和 QQ 前缀标签后的正文，原始文本完整留在 `sessions/*.jsonl`。引用消息嵌套、收尾标签被截断时会逐层剥，不会把 `</user_message>` 漏进记忆。

## 日记与笔记

工作区里已经写好的 markdown 不自动抓，是显式导入：

```
node tools/import-notes.mjs --dir=~/.dsh/whale-work/日记
```

只读原文件，按标题和长度切块，整份重写 `episodes/diary.jsonl`，可以反复跑。检索时带 `channel: 'diary'`，和对话记忆分两个池子，不拖慢默认检索。

## 数据目录

默认 `$DSH_HOME/yunqi-memory`，可用 `config.dir` 覆盖。

```
sessions/<sessionId>.jsonl      会话事件全量账本（只增；超过 16MB 归档 .bak，不删）
episodes/<workspaceKey>.jsonl   每回合一条，检索单元
state/<sessionId>.json + .md    当前状态（每轮重写；md 给人看）
state/checkpoints/              压缩前快照
memory/facts.jsonl              yunqi_remember 写的事实（type: fact 与 retire，作废只追加标记）
persona/stable.md               稳定核，模型写、主人可改（每次重写旧版进 history/）
persona/growable.jsonl          成长提案
persona/decisions.jsonl         采纳/拒绝记录
usage.jsonl                     判断账本（surface / cite / correct）
judgments.jsonl                 可读回执
audit.jsonl                     回合与异常
```

每类 JSONL 行内带 `schema: 1`，以后改格式按版本读。

事实层的作废借自 `sage-mem/lib/memory/arbitrate.js` 与 `Hers_Life/dsh-ming-core-memory/lib/index.js:514-528`：作废是**写进存储的事实**，旧行一个字节都不改，只是多一行 `type: "retire"`。`fact` 行带 `tags` / `sessionId` / `ws` / `ts`；超过 45 天没复核的注入时标「久未复核」。

## 安装与配置

把本仓库放到 `<你的 DSH 目录>/plugins/yunqi-memory`，然后在 profile 的 `cordis.patch.yml` 里插入：

```yaml
- insert:
    - id: yunqi-memory
      name: "<你的 DSH 目录>/plugins/yunqi-memory/index.js"
      config:
        dir: ""                  # 留空 = $DSH_HOME/yunqi-memory
        captureReasoning: true   # 账本里留思考
        captureToolResults: false# 工具结果默认不落账本（省盘）
        stateInject: true        # 是否注入状态块
        identityInject: true     # 是否注入身份块（稳定核 + 已采纳成长）
```

重启 DSH，工具列表里出现 `yunqi_recall` / `yunqi_remember` / `yunqi_persona` 就是装好了。

## 测试

```bash
node test/smoke.mjs
```

输出 `smoke ok` 即通过。测试自己建临时目录，不碰真实数据。

## 怎么判「养得好」

- 隔天问「昨天做到哪」——状态块能答，不用翻历史。
- 问一件旧事——`yunqi_recall` 给原文和出处，而不是摘要。
- 纠正过一次的说法——下一轮不再出现，`usage.jsonl` 里有 `correct` 行。
- 问「你为什么记得这个」——`judgments.jsonl` 能查到什么时候被搜到、被引用、被纠正。

## 不做的事

- 不接管压缩、不改会话历史、不删除宿主消息。
- 稳定核的每次重写都留旧版（`persona/history/`）；成长提案只有人明确采纳才生效。
- 不联网、无第三方依赖、不调用模型。

## 已知边界

- 只覆盖本插件安装之后的会话；旧会话要回填需要另外导入。
- 检索是词面 BM25，不会语义泛化；问法差太远可能查不到。加了一道证据门槛（命中权重占比 / 连续命中 / 稀有词）挡住只在虚词上撞到的旧事，整批都不够时退回最像的几个。
- `captureToolResults: false` 时，工具结果只在当轮 Episode 里留 600 字，不进 L1 账本。
- 来源对老会话只能推断：会话名不带 `onebot-group/private` 时按正文 `·成员` 判；在 DSH 里贴一段 QQ 信封也会被判成 QQ（少见）。
