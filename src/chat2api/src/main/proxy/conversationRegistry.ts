/**
 * Conversation Registry
 *
 * 把上层（agent 客户端）的一次会话映射到：
 *   1. 固定的 provider / 账号（避免负载均衡把同一会话打到不同账号，各建一份远端会话）
 *   2. 远端会话 ID（网页端 chat/session id），同一会话内复用，不再每次新建
 *
 * 会话键的解析优先级：
 *   1. 请求头 X-Conversation-Id / X-Session-Id / X-Chat-Id（客户端能发就用，最准）
 *   2. 请求体 conversation_id / session_id / chat_id
 *   3. OpenAI 标准字段 user
 *   4. 历史链匹配兜底：把 messages 逐条累积哈希成链条，凡与已登记会话的链条前缀相交即视为同一会话
 *      （agent 每轮都会重发完整历史，历史前缀在会话内稳定；system 常含动态内容，故不参与）
 *   5. 单条消息哈希兜底：客户端裁剪过历史时，用最近一条稳定消息内容定位会话
 */

import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

export interface ConversationBinding {
  providerId?: string
  accountId?: string
  remote: Record<string, string>
  parent: Record<string, string>
  lastActiveAt: number
}

export interface ResolveKeyInput {
  headers: Record<string, any>
  body: any
  apiKey?: string
}

const TTL_MS = 12 * 60 * 60 * 1000
const MAX_ENTRIES = 500
/** 单个会话最多登记的链节点 */
const MAX_SIGS_PER_CONVERSATION = 600
/** 全局索引上限，超出按插入顺序淘汰 */
const MAX_SIG_INDEX = 40000
/** 单条消息匹配要求的最小内容长度，太短容易误配 */
const MIN_MSG_LEN_FOR_MATCH = 24
/**
 * 严格模式不变量：同一 apiKey + model 存在活跃会话时，一律复用，
 * 只有「明确的新会话首轮」才允许新建。新会话首轮需同时满足：
 *   1. 请求只有一条非 system 消息
 *   2. 该消息不是已登记会话里的重试
 *   3. 距上次活跃超过 NEW_SESSION_IDLE_MS
 * 这样 agent 一个对话内（连续轮必然携带历史）永远不会新建第二个网页会话。
 */
const NEW_SESSION_IDLE_MS = 10 * 60 * 1000

const HEADER_KEYS = ['x-conversation-id', 'x-session-id', 'x-chat-id']
const BODY_KEYS = ['conversation_id', 'conversationId', 'session_id', 'sessionId', 'chat_id', 'chatId']

function debugLog(payload: Record<string, any>): void {
  if (process.env.CHAT2API_DEBUG_SESSION !== '1') return
  try {
    const dir = join(homedir(), '.chat2api')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'session-debug.ndjson'), JSON.stringify({ ts: Date.now(), ...payload }) + '\n', 'utf8')
  } catch {
    /* 调试日志失败不影响主流程 */
  }
}

class ConversationRegistryClass {
  private bindings = new Map<string, ConversationBinding>()
  /** 累积链节点 -> 会话键 */
  private chainIndex = new Map<string, string>()
  /** 单条消息哈希 -> 会话键 */
  private msgIndex = new Map<string, string>()
  /** apiKey|model -> 最近活跃会话，用于客户端不重发历史时的续接 */
  private recentByScope = new Map<string, { key: string; at: number; msgCount: number }>()

  resolveKey(input: ResolveKeyInput): string {
    const headers = input.headers || {}
    const body = input.body || {}
    const texts = collectTexts(body.messages)
    const scope = `${input.apiKey || ''}|${body.model || ''}`
    for (const name of HEADER_KEYS) {
      const value = headers[name]
      if (typeof value === 'string' && value.trim().length > 0) {
        const key = `h:${value.trim()}`
        debugLog({ source: 'header', header: name, key })
        return this.finalize(scope, key, texts.length)
      }
    }

    // body 里的会话字段只作为「无活跃会话时」的命名依据：
    // 部分客户端每轮都生成新的 user / conversation_id，直接当会话键会导致每轮新建
    let bodyKey = ''
    for (const field of BODY_KEYS) {
      const value = body[field]
      if (typeof value === 'string' && value.trim().length > 0) {
        bodyKey = `b:${value.trim()}`
        break
      }
    }
    if (!bodyKey && typeof body.user === 'string' && body.user.trim().length > 0) {
      bodyKey = `u:${body.user.trim()}`
    }

    const chains = buildChain(texts)
    const msgHashes = texts.map(hashMessage)

    // 1) 历史链匹配：从最新往前找，命中即同一会话
    for (let i = chains.length - 1; i >= 0; i--) {
      const hit = this.chainIndex.get(chains[i])
      if (hit) {
        const binding = this.getBinding(hit)
        if (binding) {
          this.remember(hit, body.messages)
          debugLog({ source: 'chain', key: hit, matchedAt: i, chainLen: chains.length, msgCount: texts.length })
          return this.finalize(scope, hit, texts.length)
        }
        this.chainIndex.delete(chains[i])
      }
    }

    // 2) 单条消息匹配：客户端裁剪历史后仍可定位
    for (let i = msgHashes.length - 1; i >= 0; i--) {
      if (texts[i].length < MIN_MSG_LEN_FOR_MATCH) continue
      const hit = this.msgIndex.get(msgHashes[i])
      if (hit) {
        const binding = this.getBinding(hit)
        if (binding) {
          this.remember(hit, body.messages)
          debugLog({ source: 'message', key: hit, matchedAt: i, msgCount: texts.length })
          return this.finalize(scope, hit, texts.length)
        }
        this.msgIndex.delete(msgHashes[i])
      }
    }

    // 3) 严格续接：scope 内有活跃会话，除「明确的新会话首轮」外一律复用
    const recent = this.recentByScope.get(scope)
    const recentBinding = recent ? this.getBinding(recent.key) : undefined
    if (recent && recentBinding) {
      const idleMs = Date.now() - recent.at
      const firstHash = msgHashes[0]
      const isRetry = firstHash ? this.msgIndex.has(firstHash) : false
      const freshFirstTurn = texts.length <= 1 && !isRetry && idleMs > NEW_SESSION_IDLE_MS
      if (!freshFirstTurn) {
        this.remember(recent.key, body.messages)
        debugLog({ source: 'reuse', key: recent.key, idleMs, msgCount: texts.length })
        return this.finalize(scope, recent.key, texts.length)
      }
    }

    // 4) 新会话：仅在没有活跃会话，或明确判定为新会话首轮时到达
    if (chains.length === 0) {
      debugLog({ source: 'none', msgCount: texts.length })
      return ''
    }
    const key = bodyKey || `f:${chains[chains.length - 1].slice(0, 24)}`
    this.remember(key, body.messages)
    debugLog({
      source: 'new',
      key,
      msgCount: texts.length,
      roles: (body.messages || []).map((m: any) => m && m.role).join(','),
      firstText: texts[0] ? texts[0].slice(0, 60) : '',
    })
    return this.finalize(scope, key, texts.length)
  }

  private finalize(scope: string, key: string, msgCount = 0): string {
    if (key) {
      // 立刻建立绑定，续接判断不再依赖外部是否先调用过 bind()
      this.ensure(key)
      this.recentByScope.set(scope, { key, at: Date.now(), msgCount })
    }
    return key
  }

  /** 把请求携带的历史登记到索引，供后续轮次命中 */
  private remember(key: string, messages: any): void {
    if (!key) return
    const texts = collectTexts(messages)
    if (texts.length === 0) return

    const chains = buildChain(texts)
    const startChain = Math.max(0, chains.length - MAX_SIGS_PER_CONVERSATION)
    for (let i = startChain; i < chains.length; i++) {
      this.chainIndex.set(chains[i], key)
    }
    const startMsg = Math.max(0, texts.length - MAX_SIGS_PER_CONVERSATION)
    for (let i = startMsg; i < texts.length; i++) {
      if (texts[i].length < MIN_MSG_LEN_FOR_MATCH) continue
      this.msgIndex.set(hashMessage(texts[i]), key)
    }
    this.trimIndex()
  }

  private trimIndex(): void {
    while (this.chainIndex.size > MAX_SIG_INDEX) {
      const first = this.chainIndex.keys().next()
      if (first.done) break
      this.chainIndex.delete(first.value)
    }
    while (this.msgIndex.size > MAX_SIG_INDEX) {
      const first = this.msgIndex.keys().next()
      if (first.done) break
      this.msgIndex.delete(first.value)
    }
  }

  getBinding(key?: string): ConversationBinding | undefined {
    if (!key) return undefined
    const binding = this.bindings.get(key)
    if (!binding) return undefined
    if (Date.now() - binding.lastActiveAt > TTL_MS) {
      this.bindings.delete(key)
      return undefined
    }
    return binding
  }

  bind(key: string | undefined, providerId: string, accountId: string): void {
    const binding = this.ensure(key)
    if (!binding) return
    binding.providerId = providerId
    binding.accountId = accountId
    binding.lastActiveAt = Date.now()
  }

  getRemoteId(providerId: string, key?: string): string | undefined {
    const binding = this.getBinding(key)
    if (!binding) return undefined
    const value = binding.remote[providerId]
    binding.lastActiveAt = Date.now()
    return value || undefined
  }

  getParentId(providerId: string, key?: string): string | undefined {
    const binding = this.getBinding(key)
    if (!binding) return undefined
    return binding.parent[providerId] || undefined
  }

  setRemoteId(providerId: string, key: string | undefined, remoteId: string, parentId?: string): void {
    const binding = this.ensure(key)
    if (!binding) return
    binding.remote[providerId] = remoteId
    if (parentId) {
      binding.parent[providerId] = parentId
    }
    binding.lastActiveAt = Date.now()
    debugLog({ source: 'setRemote', key, providerId, remoteId, parentId })
  }

  clearRemote(providerId: string, key?: string): void {
    const binding = this.getBinding(key)
    if (!binding) return
    delete binding.remote[providerId]
    delete binding.parent[providerId]
  }

  /** 清掉某平台在全部会话上的远端绑定（例如“删除全部对话”后） */
  clearProvider(providerId: string): void {
    for (const binding of this.bindings.values()) {
      delete binding.remote[providerId]
      delete binding.parent[providerId]
    }
  }

  private ensure(key?: string): ConversationBinding | undefined {
    if (!key) return undefined
    let binding = this.bindings.get(key)
    if (!binding) {
      this.evictIfNeeded()
      binding = { remote: {}, parent: {}, lastActiveAt: Date.now() }
      this.bindings.set(key, binding)
    }
    return binding
  }

  private evictIfNeeded(): void {
    const now = Date.now()
    for (const [key, binding] of this.bindings) {
      if (now - binding.lastActiveAt > TTL_MS) {
        this.bindings.delete(key)
      }
    }
    if (this.bindings.size < MAX_ENTRIES) return

    const ordered = [...this.bindings.entries()].sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt)
    const removeCount = this.bindings.size - MAX_ENTRIES + 1
    for (let i = 0; i < removeCount && i < ordered.length; i++) {
      this.bindings.delete(ordered[i][0])
    }
  }
}

function extractText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : ''))
      .join('')
  }
  return ''
}

/** 收集参与会话识别的文本：跳过 system（常含时间/环境等动态内容） */
function collectTexts(messages: any): string[] {
  if (!Array.isArray(messages)) return []
  const out: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') continue
    const text = normalize(extractText(message.content))
    if (!text) continue
    out.push(`${message.role}:${text}`)
  }
  return out
}

/** 归一化：超长内容取首尾采样，避免大段工具输出拖慢哈希 */
function normalize(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 8000) return trimmed
  return `${trimmed.length}|${trimmed.slice(0, 6000)}|${trimmed.slice(-1500)}`
}

function hashMessage(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/** 逐条累积哈希，得到“对话前缀链”：同一会话第 N 轮请求的前 N-1 个节点必然与历史一致 */
function buildChain(texts: string[]): string[] {
  const out: string[] = []
  let acc = ''
  for (const text of texts) {
    acc = createHash('sha256').update(acc).update('\u0000').update(text).digest('hex')
    out.push(acc)
  }
  return out
}

export const conversationRegistry = new ConversationRegistryClass()
export type ConversationRegistry = ConversationRegistryClass
