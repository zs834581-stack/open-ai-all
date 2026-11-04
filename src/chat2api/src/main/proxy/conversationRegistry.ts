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
 *   4. 指纹兜底：apiKey + system prompt + 首条 user 消息（agent 会话内这三样稳定，新会话必变）
 */

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
const HEADER_KEYS = ['x-conversation-id', 'x-session-id', 'x-chat-id']
const BODY_KEYS = ['conversation_id', 'conversationId', 'session_id', 'sessionId', 'chat_id', 'chatId']

class ConversationRegistryClass {
  private bindings = new Map<string, ConversationBinding>()

  resolveKey(input: ResolveKeyInput): string {
    const headers = input.headers || {}
    for (const name of HEADER_KEYS) {
      const value = headers[name]
      if (typeof value === 'string' && value.trim().length > 0) {
        return `h:${value.trim()}`
      }
    }

    const body = input.body || {}
    for (const field of BODY_KEYS) {
      const value = body[field]
      if (typeof value === 'string' && value.trim().length > 0) {
        return `b:${value.trim()}`
      }
    }

    if (typeof body.user === 'string' && body.user.trim().length > 0) {
      return `u:${body.user.trim()}`
    }

    const fingerprint = buildFingerprint(body.messages)
    if (!fingerprint) {
      return ''
    }
    const seed = `${input.apiKey || ''}|${fingerprint}`
    return `f:${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
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

function buildFingerprint(messages: any): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''

  let system = ''
  let firstUser = ''
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if (!system && message.role === 'system') {
      system = extractText(message.content)
      continue
    }
    if (!firstUser && message.role === 'user') {
      firstUser = extractText(message.content)
    }
    if (system && firstUser) break
  }

  if (!system && !firstUser) return ''
  // system 只取前缀：部分 agent 会在末尾追加动态上下文，取全量会导致同一会话内指纹漂移
  const systemPart = createHash('sha256').update(system.slice(0, 500)).digest('hex').slice(0, 16)
  const userPart = createHash('sha256').update(firstUser.slice(0, 2000)).digest('hex').slice(0, 16)
  return `${systemPart}:${userPart}`
}

export const conversationRegistry = new ConversationRegistryClass()
export type ConversationRegistry = ConversationRegistryClass
