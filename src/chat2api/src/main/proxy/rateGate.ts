/**
 * Rate Gate
 *
 * 厂商风控规避：为每个 (账号, 厂商) 维护两条节奏控制，让 agent 的连续调用
 * 节奏对齐「人工在网页端逐条输入」的自然间隔：
 *
 *  1. 最小间隔 + 随机抖动：两次请求之间至少间隔 minGap，且实际等待在
 *     [minGap, minGap + jitterMax] 内随机，避免固定周期被识别为脚本。
 *  2. 令牌桶：限制突发速率（burstSize），即使 agent 多轮并发也按桶释放。
 *
 * 厂商差异示例（人工网页使用者特征）：
 *   - DeepSeek：回复完再思考下一句 → 间隔偏大（~3-6s），PoW 打点本身也拉长时间
 *   - Kimi / 百炼：打字回复节奏类似 2-4s
 *   - 通用：默认 2-4s + 抖动
 *
 * 用法（adapter 内每个 await 调用前）：
 *   await providerGate.forAccount('deepseek', account.id)
 *
 * 命中 429 后：
 *   await providerGate.reportThrottled('deepseek', account.id, retryAfterSec?)
 *   期间同账号新请求会排队直到冷却结束。
 */

interface GateState {
  /** 上次放行的时间戳（用于最小间隔 + 抖动） */
  lastRelease: number
  /** 令牌桶剩余令牌 */
  tokens: number
  /** 桶最后补充时间 */
  lastRefill: number
  /** 冷却截止时间（429 惩罚），0 表示无冷却 */
  cooldownUntil: number
}

export interface RateGateOptions {
  /** 厂商名（deepseek / kimi / qwen / glm / zai / minimax / mimo / perplexity / default） */
  provider: string
}

/** 各厂商节奏预设：{ 最小间隔 ms, 最大附加抖动 ms, 突发容量, 桶恢复间隔 ms, 429 冷却基础 ms, 429 冷却上限 ms, 429 重试退避基数 ms } */
interface ProviderProfile {
  minGap: number
  jitterMax: number
  burst: number
  refillMs: number
  /** 429 后账号冷却基础时长（无 Retry-After 时用） */
  cooldownBaseMs: number
  /** 429 后账号冷却上限 */
  cooldownMaxMs: number
  /** 429 指数退避基数（forwarder 用），不同厂商风控恢复速度差异大 */
  retryDelayMs: number
}

const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  // DeepSeek：风控最严，冷却长、退避慢、间隔大
  deepseek: { minGap: 5000, jitterMax: 3000, burst: 1, refillMs: 6000, cooldownBaseMs: 60_000, cooldownMaxMs: 300_000, retryDelayMs: 20_000 },
  // Kimi / 百炼：中等
  kimi: { minGap: 3500, jitterMax: 2000, burst: 2, refillMs: 4000, cooldownBaseMs: 30_000, cooldownMaxMs: 120_000, retryDelayMs: 10_000 },
  qwen: { minGap: 3500, jitterMax: 2000, burst: 2, refillMs: 4000, cooldownBaseMs: 30_000, cooldownMaxMs: 120_000, retryDelayMs: 10_000 },
  glm: { minGap: 3500, jitterMax: 2000, burst: 2, refillMs: 4000, cooldownBaseMs: 30_000, cooldownMaxMs: 120_000, retryDelayMs: 10_000 },
  zai: { minGap: 3500, jitterMax: 2000, burst: 2, refillMs: 4000, cooldownBaseMs: 30_000, cooldownMaxMs: 120_000, retryDelayMs: 10_000 },
  minimax: { minGap: 3000, jitterMax: 2000, burst: 2, refillMs: 4000, cooldownBaseMs: 25_000, cooldownMaxMs: 100_000, retryDelayMs: 8_000 },
  mimo: { minGap: 3000, jitterMax: 2000, burst: 2, refillMs: 4000, cooldownBaseMs: 25_000, cooldownMaxMs: 100_000, retryDelayMs: 8_000 },
  perplexity: { minGap: 3000, jitterMax: 2000, burst: 2, refillMs: 4000, cooldownBaseMs: 25_000, cooldownMaxMs: 100_000, retryDelayMs: 8_000 },
  default: { minGap: 3500, jitterMax: 2000, burst: 2, refillMs: 4000, cooldownBaseMs: 30_000, cooldownMaxMs: 120_000, retryDelayMs: 10_000 },
}

/** 取某厂商的 429 指数退避基数（forwarder 调用） */
export function getProviderRetryDelayMs(provider: string): number {
  return (PROVIDER_PROFILES[provider] || PROVIDER_PROFILES.default).retryDelayMs
}

/** 取某厂商的 429 冷却基础时长（ms） */
export function getProviderCooldownBaseMs(provider: string): number {
  return (PROVIDER_PROFILES[provider] || PROVIDER_PROFILES.default).cooldownBaseMs
}

/** 取某厂商的 429 冷却上限（ms） */
export function getProviderCooldownMaxMs(provider: string): number {
  return (PROVIDER_PROFILES[provider] || PROVIDER_PROFILES.default).cooldownMaxMs
}

class ProviderGate {
  private state: GateState
  private profile: ProviderProfile
  private readonly provider: string

  constructor(provider: string) {
    this.provider = provider
    this.profile = PROVIDER_PROFILES[provider] || PROVIDER_PROFILES.default
    this.state = { lastRelease: 0, tokens: this.profile.burst, lastRefill: Date.now(), cooldownUntil: 0 }
  }

  /** 等待节奏闸门放行（最小间隔 + 抖动 + 令牌桶 + 429 冷却） */
  async wait(): Promise<void> {
    while (true) {
      const now = Date.now()
      const waiters: number[] = []

      // 1. 429 冷却优先
      if (this.state.cooldownUntil > now) {
        waiters.push(this.state.cooldownUntil - now)
      }

      // 2. 最小间隔 + 随机抖动（每次独立掷骰，保证非周期性）
      const minWait =
        this.state.lastRelease + this.profile.minGap +
        Math.floor(Math.random() * (this.profile.jitterMax + 1)) - now
      if (minWait > 0) waiters.push(minWait)

      // 3. 令牌桶：需要令牌且桶空时，按 refillMs 节奏补充
      if (this.state.tokens < 1) {
        const refillAt = this.state.lastRefill + this.profile.refillMs - now
        waiters.push(refillAt > 0 ? refillAt : 0)
      }

      if (waiters.length === 0 || waiters.every((w) => w === 0)) {
        // 放行
        const stillCooling = this.state.cooldownUntil > Date.now()
        if (stillCooling) {
          await sleep(50)
          continue
        }
        if (this.state.tokens < 1) {
          // 到点补充令牌（可能补充多枚，上限 burst）
          const elapsed = Date.now() - this.state.lastRefill
          const refilled = Math.floor(elapsed / this.profile.refillMs)
          this.state.tokens = Math.min(this.profile.burst, this.state.tokens + Math.max(1, refilled))
          this.state.lastRefill = Date.now()
        }
        this.state.tokens -= 1
        this.state.lastRelease = Date.now()
        return
      }

      await sleep(Math.max(50, ...waiters.filter((w) => w > 0)))
    }
  }

  /**
   * 报告被 429 限流：进入冷却，冷却时长 = min(retryAfter, 上限) 或按连击递增
   * @param retryAfterSec 响应头 Retry-After（秒），无则用基础值
   */
  reportThrottled(retryAfterSec?: number): void {
    const base = retryAfterSec && retryAfterSec > 0
      ? retryAfterSec * 1000
      : this.profile.cooldownBaseMs
    this.state.cooldownUntil = Date.now() + Math.min(base, this.profile.cooldownMaxMs)
    this.state.tokens = 0
  }

  /** 剩余冷却 ms（0 = 无冷却） */
  cooldownRemaining(): number {
    return Math.max(0, this.state.cooldownUntil - Date.now())
  }

  get providerName(): string {
    return this.provider
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

class RateGateClass {
  private gates = new Map<string, Map<string, ProviderGate>>()
  /** 429 连击计数（冷却翻倍用） */
  private throttleStreak = new Map<string, number>()

  private key(provider: string, accountId: string): string {
    return `${provider}|${accountId}`
  }

  /** 获取（惰性创建）某账号的闸门 */
  forAccount(provider: string, accountId: string): ProviderGate {
    let map = this.gates.get(provider)
    if (!map) {
      map = new Map()
      this.gates.set(provider, map)
    }
    let gate = map.get(accountId)
    if (!gate) {
      gate = new ProviderGate(provider)
      map.set(accountId, gate)
    }
    return gate
  }

  /** 该账号被 429 时调用：记录连击并施加冷却（连击越多冷却越长） */
  reportThrottled(provider: string, accountId: string, retryAfterSec?: number): void {
    const k = this.key(provider, accountId)
    const streak = (this.throttleStreak.get(k) || 0) + 1
    this.throttleStreak.set(k, streak)
    const gate = this.forAccount(provider, accountId)
    const effectiveRetry = retryAfterSec !== undefined
      ? retryAfterSec
      : undefined
    gate.reportThrottled(effectiveRetry)
    // 连击惩罚：冷却递增（按厂商冷却上限封顶）
    const providerCooldownMax = getProviderCooldownMaxMs(provider)
    if (streak > 1 && effectiveRetry === undefined) {
      const extra = Math.min(providerCooldownMax - getProviderCooldownBaseMs(provider), (streak - 1) * 15_000)
      const now = Date.now()
      const current = gate.cooldownRemaining()
      const target = Math.min(providerCooldownMax, getProviderCooldownBaseMs(provider) + extra)
      if (target > current) {
        gate.reportThrottled(Math.round(target / 1000))
        void now
      }
    }
    console.log(`[RateGate] ${provider}/${accountId} throttled (streak=${streak}), cooldown ${gate.cooldownRemaining()}ms`)
  }

  /** 请求成功：清零连击 */
  reportSuccess(provider: string, accountId: string): void {
    this.throttleStreak.delete(this.key(provider, accountId))
  }

  /** 该账号是否正在冷却（路由层可据此跳过选择） */
  isCooling(provider: string, accountId: string): boolean {
    return this.forAccount(provider, accountId).cooldownRemaining() > 0
  }
}

export const rateGate = new RateGateClass()
export type RateGate = typeof RateGateClass
