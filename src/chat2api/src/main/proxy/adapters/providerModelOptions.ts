export interface DeepSeekChatOptionInput {
  model: string
  web_search?: boolean
  reasoning_effort?: string
}

export interface DeepSeekChatOptions {
  modelType: 'default' | 'expert'
  searchEnabled: boolean
  thinkingEnabled: boolean
}

export function resolveDeepSeekChatOptions(
  request: DeepSeekChatOptionInput,
  _prompt: string = ''
): DeepSeekChatOptions {
  const modelLower = request.model.toLowerCase()
  const isProModel = modelLower.includes('pro') || modelLower.includes('expert')
  const isSearchAlias = modelLower.includes('search')
  const isThinkingAlias = modelLower.includes('think')
    || modelLower.includes('r1')
    || modelLower.includes('reasoner')

  return {
    modelType: isProModel ? 'expert' : 'default',
    searchEnabled: Boolean(request.web_search) || isSearchAlias,
    thinkingEnabled: Boolean(request.reasoning_effort)
      || isThinkingAlias,
  }
}

export type KimiScenario = 'SCENARIO_K2D5' | 'SCENARIO_K2D6'

/**
 * 网页端 K2.8 / K3 场景值尚未公开抓包，暂按已支持的最新场景回落。
 * 拿到真实值后只需替换这里的映射，模型名与别名层无需改动。
 */
const KIMI_SCENARIO_OVERRIDES: Record<string, KimiScenario> = {
  'kimi-k2.8-preview': 'SCENARIO_K2D6',
  'kimi-k3': 'SCENARIO_K2D6',
  'kimi-k3.1': 'SCENARIO_K2D6',
}

export function resolveKimiScenario(model: string): KimiScenario {
  const modelLower = model.toLowerCase()
  const override = KIMI_SCENARIO_OVERRIDES[modelLower]
  if (override) return override
  return modelLower.includes('k2.5') ? 'SCENARIO_K2D5' : 'SCENARIO_K2D6'
}

export function createKimiChatPayload(options: {
  model: string
  content: string
  enableWebSearch: boolean
  enableThinking: boolean
  /** 复用已有会话时传入，空表示新建 */
  chatId?: string
  parentId?: string
}) {
  const scenario = resolveKimiScenario(options.model)

  return {
    scenario,
    chat_id: options.chatId || '',
    tools: options.enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
    message: {
      parent_id: options.parentId || '',
      role: 'user',
      blocks: [{
        message_id: '',
        text: { content: options.content }
      }],
      scenario,
    },
    options: {
      thinking: options.enableThinking
    }
  }
}

export function encodeKimiGrpcFrame(payload: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
  frameBuffer.writeUInt8(0, 0)
  frameBuffer.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frameBuffer, 5)
  return frameBuffer
}
