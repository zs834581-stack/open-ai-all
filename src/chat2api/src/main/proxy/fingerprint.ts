/**
 * Human-like Browser Fingerprint Generator
 *
 * 每次请求生成一套随机的但合理的浏览器指纹，模拟人工在网页端操作：
 *   - UA 版本号小幅随机偏移（不跨大版本）
 *   - Sec-Ch-Ua 与 UA 对齐
 *   - Cookie 随机化（session / trace / analytics 均为随机值）
 *   - 屏幕分辨率从真实分布中采样
 *   - 时间戳取当前真实时间
 *
 * 关键原则：
 *   1. 每个字段值在「真实浏览器可能发送的范围」内
 *   2. 同一次请求内各字段互相一致（UA 版本号 ↔ Sec-Ch-Ua）
 *   3. 不同请求之间有微小差异（避免固定指纹被风控标记）
 *   4. 绝不暴露自动化特征（无 HeadlessChrome / WebDriver / puppeteer 标识）
 */

import crypto from 'crypto'

/** 从真实世界采样的大版本号候选 */
const CHROME_VERSIONS = [131, 132, 133, 134, 135, 136, 137, 138, 143, 144, 145, 148]
const EDGE_VERSIONS  = [131, 132, 133, 134, 135, 136, 137, 138, 143, 144, 145]

/** 真实屏幕分辨率分布（Desktop 主流） */
const SCREEN_SIZES = [
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
  { w: 1366, h: 768  },
  { w: 1536, h: 864  },
  { w: 1440, h: 900  },
  { w: 1680, h: 1050 },
  { w: 1280, h: 720  },
  { w: 1512, h: 982  },
  { w: 2560, h: 1600 },
  { w: 3840, h: 2160 },
]

/** 真实色彩深度 */
const COLOR_DEPTHS = [24, 30, 32]
/** 真实设备像素比 */
const PIXEL_RATIOS = [1, 1.25, 1.5, 2]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomHex(length: number): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export interface BrowserFingerprint {
  /** 完整 User-Agent */
  userAgent: string
  /** Sec-Ch-Ua header value (quoted) */
  secChUa: string
  /** Sec-Ch-Ua-Mobile */
  secChUaMobile: string
  /** Sec-Ch-Ua-Platform */
  secChUaPlatform: string
  /** Chrome/Edge 大版本号 */
  majorVersion: number
  /** 小版本号 (0-99) */
  minorVersion: number
  /** 屏幕尺寸 */
  screen: { w: number; h: number }
  /** 视口尺寸 (<= 屏幕) */
  viewport: { w: number; h: number }
  /** 色彩深度 */
  colorDepth: number
  /** 设备像素比 */
  pixelRatio: number
  /** 平台标识 */
  platform: string
  /** 时区偏移 (分钟) */
  timezoneOffset: number
}

/**
 * 生成一套 Chrome (macOS/Windows) 浏览器指纹
 */
export function generateChromeFingerprint(os: 'mac' | 'win' = 'win'): BrowserFingerprint {
  const major = pick(CHROME_VERSIONS)
  const minor = randInt(0, 99)
  const uaVersion = `${major}.0.${randInt(4000, 5999)}.${minor}`

  const platform = os === 'mac' ? 'macOS' : 'Windows'
  const platformUa = os === 'mac' ? 'Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64'

  const screen = pick(SCREEN_SIZES)
  const viewport = {
    w: Math.min(screen.w - randInt(0, 100), screen.w),
    h: Math.min(screen.h - randInt(30, 120), screen.h),
  }

  return {
    userAgent: `Mozilla/5.0 (${platformUa}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${uaVersion} Safari/537.36`,
    secChUa: `"Chromium";v="${major}", "Not/A)Brand";v="99", "Google Chrome";v="${major}"`,
    secChUaMobile: '?0',
    secChUaPlatform: `"${platform}"`,
    majorVersion: major,
    minorVersion: minor,
    screen,
    viewport,
    colorDepth: pick(COLOR_DEPTHS),
    pixelRatio: pick(PIXEL_RATIOS),
    platform,
    timezoneOffset: os === 'win' ? -480 : -480,
  }
}

/**
 * 生成一套 Edge (Windows) 浏览器指纹
 */
export function generateEdgeFingerprint(): BrowserFingerprint {
  const major = pick(EDGE_VERSIONS)
  const minor = randInt(0, 99)
  const uaVersion = `${major}.0.${randInt(4000, 5999)}.${minor}`

  const screen = pick(SCREEN_SIZES)
  const viewport = {
    w: Math.min(screen.w - randInt(0, 100), screen.w),
    h: Math.min(screen.h - randInt(30, 120), screen.h),
  }

  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${uaVersion} Safari/537.36 Edg/${uaVersion}`,
    secChUa: `"Microsoft Edge";v="${major}", "Chromium";v="${major}", "Not A(Brand";v="24"`,
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
    majorVersion: major,
    minorVersion: minor,
    screen,
    viewport,
    colorDepth: pick(COLOR_DEPTHS),
    pixelRatio: pick(PIXEL_RATIOS),
    platform: 'Windows',
    timezoneOffset: -480,
  }
}

/**
 * 构建通用浏览器请求头（每请求调用一次，返回带随机指纹的完整头集合）
 * 各 adapter 可在此基础上追加厂商特有头。
 */
export function buildBrowserHeaders(options: {
  origin: string
  referer?: string
  accept?: string
  contentType?: string
  os?: 'mac' | 'win'
  browser?: 'chrome' | 'edge'
}): Record<string, string> {
  const fp = options.browser === 'edge'
    ? generateEdgeFingerprint()
    : generateChromeFingerprint(options.os || 'win')

  const headers: Record<string, string> = {
    Accept: options.accept || '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
    'Cache-Control': 'no-cache',
    Origin: options.origin,
    Pragma: 'no-cache',
    Referer: options.referer || `${options.origin}/`,
    'Sec-Ch-Ua': fp.secChUa,
    'Sec-Ch-Ua-Mobile': fp.secChUaMobile,
    'Sec-Ch-Ua-Platform': fp.secChUaPlatform,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': fp.userAgent,
  }

  if (options.contentType) {
    headers['Content-Type'] = options.contentType
  }

  return headers
}

/**
 * DeepSeek 专用 Cookie 生成（每次随机，模拟浏览器 session）
 */
export function generateDeepSeekCookie(): string {
  const now = Date.now()
  const sec = Math.floor(now / 1000)
  return [
    `intercom-HWWAFSESTIME=${now}`,
    `HWWAFSESID=${randomHex(18)}`,
    `Hm_lvt_${uuid().replace(/-/g, '')}=${sec},${sec},${sec}`,
    `Hm_lpvt_${uuid().replace(/-/g, '')}=${sec}`,
    `_frid=${uuid().replace(/-/g, '')}`,
    `_fr_ssid=${uuid().replace(/-/g, '')}`,
    `_fr_pvid=${uuid().replace(/-/g, '')}`,
  ].join('; ')
}

/**
 * GLM 请求签名中使用的 Device-Id / Request-Id（每次随机）
 */
export function generateGLMDeviceId(): string {
  return uuid()
}
export function generateGLMRequestId(): string {
  return uuid()
}

/**
 * Qwen 请求中使用的 DeviceId（每次随机，不固定为硬编码值）
 */
export function generateQwenDeviceId(): string {
  return uuid()
}

/**
 * MiniMax 请求中 UUID / device_id（每次随机）
 */
export function generateMiniMaxUuid(): string {
  return uuid()
}
