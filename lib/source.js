/**
 * 消息来源：一条 user/message 到底是谁、从哪来的。
 *
 * 只做结构解析，不猜内容：
 *   - harness：DSH 界面里人直接说的话（source.kind 缺省或 'user'）
 *   - qq:private / qq:group：onebot 插件转进来的 QQ 消息；说话人从 <user_message> 信封取，
 *     群/私聊优先看会话 id（onebot-group-<群号> / onebot-private-<QQ号>），
 *     老会话没有这层命名时退回正文里的「·成员」标记
 *   - injected：runtime-context / skill-catalog / time-context / qqbot:group-rules 等注入块，
 *     它们不是人说的话，不该算进「用户原话」
 *
 * @typedef {Object} MessageSource
 * @property {string} channel   harness | qq:private | qq:group | injected | diary | fact | unknown
 * @property {string} platform  harness | qq | injected | unknown
 * @property {string} [kind]    原始 source.kind，排错用
 * @property {string} [peerId]  onebot 会话名里的群号或 QQ 号
 * @property {string} [speakerId]    <user_message qq="...">
 * @property {string} [speakerName]  <user_message nickname="...">
 */

const QQ_ENVELOPE_RE = /<user_message\b[^>]*>([\s\S]*?)<\/user_message>/i
const QQ_TAG_RE = /<user_message\b([^>]*)>/i
const ATTR_QQ_RE = /\bqq="([^"]*)"/i
const ATTR_NICK_RE = /\bnickname="([^"]*)"/i
// 只剥 QQ 桥自己加的前缀标签；[图片:…] / [表情包:…] 这类是正文，不能当标签吃掉。
const LEAD_TAGS_RE = /^(?:\s*\[(?:受限用户:[^\]]*|\d{1,2}:\d{2}[^\]]*|@我)\])+\s*/
const MEMBER_MARK_RE = /·(?:成员|管理|群主)/
const ONE_BOT_SESSION_RE = /^onebot-(group|private)-(\d+)/i

export function looksLikeQqText(text) {
  return /<\/?user_message\b/i.test(String(text ?? ''))
}

/**
 * 从会话 id + user/message 的 data + 正文解析来源。
 * @param {string} sessionId
 * @param {Object} data  user/message 事件的 data
 * @param {string} text  消息正文
 * @returns {MessageSource}
 */
export function parseSource(sessionId, data, text) {
  const kind = data?.source?.kind
  const rawText = String(text ?? '')

  if (kind === 'plugin:dsh-onebot' || looksLikeQqText(rawText)) {
    const source = { channel: 'qq:private', platform: 'qq' }
    if (kind !== undefined) source.kind = kind
    const named = ONE_BOT_SESSION_RE.exec(String(sessionId ?? ''))
    if (named) {
      source.channel = named[1].toLowerCase() === 'group' ? 'qq:group' : 'qq:private'
      source.peerId = named[2]
    } else if (MEMBER_MARK_RE.test(rawText)) {
      source.channel = 'qq:group'
    }
    const tag = QQ_TAG_RE.exec(rawText)
    if (tag) {
      const attrs = tag[1]
      const qq = ATTR_QQ_RE.exec(attrs)
      const nick = ATTR_NICK_RE.exec(attrs)
      if (qq) source.speakerId = qq[1]
      if (nick?.[1]) source.speakerName = nick[1]
    }
    return source
  }

  if (kind === undefined || kind === 'user') {
    const source = { channel: 'harness', platform: 'harness' }
    if (kind === 'user') source.kind = kind
    return source
  }

  return { channel: 'injected', platform: 'injected', kind: String(kind) }
}

/**
 * 去掉 QQ 信封和前缀标签，只留人说的话。原始文本仍完整保存在 L1 账本里。
 * 非 QQ 来源原样返回。
 * @param {string} text
 * @param {MessageSource} [source]
 */
export function cleanUserText(text, source) {
  const raw = String(text ?? '')
  if (source?.platform !== 'qq') return raw
  let body = raw
  // QQ 引用会套信封：外层正文里还带着被引用消息的信封，逐层剥，最多四层。
  for (let i = 0; i < 4; i += 1) {
    const envelope = QQ_ENVELOPE_RE.exec(body)
    if (!envelope) break
    body = envelope[1]
  }
  // 被截断的收尾标签（`</user_message` 后没有 `>`）会带着引用尾巴，整行去掉。
  body = body
    .split('\n')
    .filter((line) => !/^\s*<\/?user_message\b/i.test(line))
    .join('\n')
  // 收尾标签可能被日志截断成 `</user_message`（没有 `>`），只吃到行尾，避免吞掉正文。
  body = body.replace(/<\/?user_message\b[^>\n]*>?/gi, '')
  return body.replace(LEAD_TAGS_RE, '').trim()
}

/** 给人看/给模型看的来源短标签。 */
export function sourceLabel(source) {
  const channel = source?.channel
  if (channel === 'qq:group') return source?.speakerName ? `QQ群 · ${source.speakerName}` : 'QQ群'
  if (channel === 'qq:private') return source?.speakerName ? `QQ私聊 · ${source.speakerName}` : 'QQ私聊'
  if (channel === 'harness') return 'DSH'
  if (channel === 'diary') return '日记'
  if (channel === 'fact') return '我记下的'
  if (channel === 'injected') return '注入'
  return '未知'
}

/**
 * 会话来源短标签：只回答「这条是哪来的」，不改变检索池。
 * 与 sourceLabel 分开：source 说「哪个平台、谁说的」，这里说「哪个会话」。
 * @param {string} sid episode 的 sid
 * @param {{currentSid?:string, channel?:string}} [opts]
 *   currentSid：当前正在说话的会话，命中它时标「本会话」；
 *   channel：事实层命中标「我记下的」——事实挂在写入它的会话下，光看 sid 认不出。
 */
export function sessionLabel(sid, opts = {}) {
  const id = String(sid ?? '').trim()
  if (id === '') return ''
  if (opts.channel === 'fact') return '我记下的'
  if (String(opts.currentSid ?? '') !== '' && id === String(opts.currentSid)) return '本会话'
  const group = /^onebot-group-(\d+)/i.exec(id)
  if (group) return `QQ群 ${group[1]}`
  if (/^onebot-private-/i.test(id)) return 'QQ私聊'
  if (/^bili-whale/i.test(id)) return 'B站鲸鱼'
  if (/^diary:/i.test(id)) return '日记'
  if (/^fact-/i.test(id)) return '我记下的'
  const short = /^(?:session-)?([0-9a-f]{8})/i.exec(id)
  if (short) return `会话 ${short[1].toLowerCase()}`
  return ''
}
