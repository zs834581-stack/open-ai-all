/**
 * 本地自动测试：会话严格对齐 + 新增模型定义
 *
 * 不运行 electron-vite / electron-builder，不产出可分发包。
 * 仅用 esbuild 把待测 TS 单文件转译到系统临时目录后做断言。
 *
 * 运行：node tests/local-alignment.test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const C2A = join(ROOT, 'src', 'chat2api')
const SRC = join(C2A, 'src', 'main')
const require = createRequire(join(C2A, 'package.json'))
const esbuild = require('esbuild')

let passed = 0
const failures = []

async function load(entry) {
  const result = await esbuild.build({
    entryPoints: [entry],
    write: false,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (e) {
    failures.push(`${name}: ${e.message}`)
    console.log(`  FAIL  ${name} -> ${e.message}`)
  }
}

function req(messages, extra = {}, apiKey = 'k1', headers = {}) {
  return {
    headers,
    apiKey,
    body: { model: 'deepseek-v4-flash', messages, ...extra },
  }
}

const sys = (n) => `你是编码代理。当前时间 2026-11-05T${n}:00:00，环境信息 ${n}`
const sleep = (n) => `第 ${n} 轮的用户问题，内容足够长以便参与消息匹配`

const { conversationRegistry: reg } = await load(join(SRC, 'proxy', 'conversationRegistry.ts'), 'registry')
const deepseek = (await load(join(SRC, 'providers', 'builtin', 'deepseek.ts'), 'ds')).deepseekConfig
const glm = (await load(join(SRC, 'providers', 'builtin', 'glm.ts'), 'glm')).glmConfig
const kimi = (await load(join(SRC, 'providers', 'builtin', 'kimi.ts'), 'kimi')).kimiConfig
const opts = await load(join(SRC, 'proxy', 'adapters', 'providerModelOptions.ts'), 'opts')
const types = await load(join(SRC, 'store', 'types.ts'), 'types')

console.log('\n[1] 会话严格对齐')

const scopeA = 'kA|deepseek-v4-flash'
const a1 = [{ role: 'system', content: sys(1) }, { role: 'user', content: sleep(1) }]
const a2 = [
  { role: 'system', content: sys(2) },
  { role: 'user', content: sleep(1) },
  { role: 'assistant', content: '第一轮的回复内容' },
  { role: 'user', content: sleep(2) },
]
const a3 = [
  ...a2,
  { role: 'assistant', content: '第二轮的回复内容' },
  { role: 'user', content: sleep(3) },
]
const kA1 = reg.resolveKey(req(a1, {}, scopeA))
const kA2 = reg.resolveKey(req(a2, {}, scopeA))
const kA3 = reg.resolveKey(req(a3, {}, scopeA))
check('标准 agent：system 动态变化 + 历史增长，3 轮同一会话键', () => {
  assert.equal(kA1, kA2)
  assert.equal(kA2, kA3)
  assert.ok(kA1)
})
check('远端会话 id 绑定后可跨轮读取', () => {
  reg.setRemoteId('deepseek', kA1, 'SID-A')
  assert.equal(reg.getRemoteId('deepseek', kA2), 'SID-A')
  assert.equal(reg.getRemoteId('deepseek', kA3), 'SID-A')
})

const scopeB = 'kB|deepseek-v4-flash'
const b1 = [{ role: 'system', content: sys(11) }, { role: 'user', content: 'B 会话第一轮：请只回复 OK' }]
const b2 = [
  { role: 'system', content: sys(12) },
  { role: 'user', content: 'B 会话第一轮：请只回复 OK' },
  { role: 'assistant', content: 'OK' },
  { role: 'user', content: 'B 会话第二轮：继续回复 OK' },
]
const kB1 = reg.resolveKey(req(b1, { user: 'uuid-1111', conversation_id: 'cid-1111' }, scopeB))
const kB2 = reg.resolveKey(req(b2, { user: 'uuid-2222', conversation_id: 'cid-2222' }, scopeB))
check('body.user / conversation_id 每轮随机变化，仍不新建会话', () => {
  assert.equal(kB1, kB2)
  assert.notEqual(kB1, kA1)
})

const scopeC = 'kC|deepseek-v4-flash'
const cMsgs = [{ role: 'system', content: sys(21) }, { role: 'user', content: 'C 并发测试：请只回复 OK' }]
const kC = await Promise.all(
  Array.from({ length: 6 }, () => Promise.resolve(reg.resolveKey(req(cMsgs, {}, scopeC))))
)
check('6 个并发请求解析出同一会话键', () => {
  assert.equal(new Set(kC).size, 1)
})

const scopeD = 'kD|deepseek-v4-flash'
const d1 = [{ role: 'system', content: sys(31) }, { role: 'user', content: 'D 会话：请只回复 OK' }]
const d2 = [
  { role: 'system', content: sys(32) },
  { role: 'user', content: '[历史摘要] 用户要求只回复 OK' },
  { role: 'assistant', content: 'OK' },
  { role: 'user', content: 'D 会话第二轮' },
]
const kD1 = reg.resolveKey(req(d1, {}, scopeD))
const kD2 = reg.resolveKey(req(d2, {}, scopeD))
check('历史被摘要改写、链断裂，仍复用同一会话', () => assert.equal(kD1, kD2))

const scopeE = 'kE|deepseek-v4-flash'
const eMsgs = [{ role: 'system', content: sys(41) }, { role: 'user', content: 'E 会话：显式会话标识测试' }]
const kE1 = reg.resolveKey(req(eMsgs, {}, scopeE, { 'x-conversation-id': 'conv-1' }))
const kE2 = reg.resolveKey(req(eMsgs, {}, scopeE, { 'x-conversation-id': 'conv-1' }))
const kE3 = reg.resolveKey(req(eMsgs, {}, scopeE, { 'x-conversation-id': 'conv-2' }))
check('显式 X-Conversation-Id 相同则复用、agent 新会话则新建', () => {
  assert.equal(kE1, kE2)
  assert.notEqual(kE1, kE3)
})

const scopeF = 'kF|deepseek-v4-flash'
const f1 = [{ role: 'system', content: sys(51) }, { role: 'user', content: 'F 会话：空闲窗口测试' }]
const kF1 = reg.resolveKey(req(f1, {}, scopeF))
const realNow = Date.now
let kF2 = ''
let kF3 = ''
try {
  Date.now = () => realNow() + 11 * 60 * 1000
  kF2 = reg.resolveKey(req(f1, {}, scopeF))
  Date.now = () => realNow() + 22 * 60 * 1000
  kF3 = reg.resolveKey(req([{ role: 'system', content: sys(52) }, { role: 'user', content: 'F 会话：全新的另一个话题' }], {}, scopeF))
} finally {
  Date.now = realNow
}
check('空闲 11 分钟后重试同一首条消息，不新建会话', () => assert.equal(kF2, kF1))
check('空闲后全新话题仍可新建会话（保持与 agent 边界一致）', () => assert.notEqual(kF3, kF1))

const scopeG = 'kG|deepseek-v4-flash'
const gKeys = new Set()
let history = [{ role: 'system', content: sys(61) }, { role: 'user', content: 'G 长会话第 1 轮：请简述你的能力' }]
for (let i = 0; i < 50; i++) {
  gKeys.add(reg.resolveKey(req(history, { user: `random-user-${i}`, conversation_id: `random-cid-${i}` }, scopeG)))
  history = [
    { role: 'system', content: sys(61 + i) },
    ...history.slice(1),
    { role: 'assistant', content: `第 ${i + 1} 轮回复` },
    { role: 'user', content: `G 长会话第 ${i + 2} 轮：继续说明` },
  ]
}
check('50 轮连续对话（system/user/cid 每轮都变）只产生 1 个会话键', () => assert.equal(gKeys.size, 1))

const scopeH = 'kH|deepseek-v4-pro'
const hMsgs = [{ role: 'system', content: sys(71) }, { role: 'user', content: 'H 另一个 model/token 的独立会话' }]
check('不同 apiKey+model 的会话互不干扰', () => {
  assert.notEqual(reg.resolveKey(req(hMsgs, {}, scopeH)), kA1)
})

console.log('\n[2] 新增模型定义')

check('DeepSeek: v4.1-flash / v4.1-pro 已加入 supportedModels', () => {
  for (const m of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash', 'deepseek-v4.1-pro']) {
    assert.ok(deepseek.supportedModels.includes(m), m)
  }
})
check('Kimi: K3 / K3.1 / K2.8-Preview 已加入', () => {
  for (const m of ['Kimi-K2.6', 'Kimi-K2.8-Preview', 'Kimi-K3', 'Kimi-K3.1']) {
    assert.ok(kimi.supportedModels.includes(m), m)
  }
})
check('GLM: 5.3 / 5.3-Flash 已加入', () => {
  for (const m of ['GLM-5.1', 'GLM-5.3', 'GLM-5.3-Flash']) {
    assert.ok(glm.supportedModels.includes(m), m)
  }
})
check('三家 provider 每个 supportedModel 都有 modelMappings', () => {
  for (const [id, cfg] of [['deepseek', deepseek], ['kimi', kimi], ['glm', glm]]) {
    for (const m of cfg.supportedModels) {
      assert.ok(cfg.modelMappings[m], `${id}: ${m}`)
    }
  }
})
check('DEEPSEEK_PRIMARY_MODELS 同步新模型', () => {
  assert.ok(types.DEEPSEEK_PRIMARY_MODELS.includes('deepseek-v4.1-flash'))
  assert.ok(types.DEEPSEEK_PRIMARY_MODELS.includes('deepseek-v4.1-pro'))
})
check('DeepSeek v4.1-pro 走 expert，flash 走 default', () => {
  assert.equal(opts.resolveDeepSeekChatOptions({ model: 'deepseek-v4.1-pro' }).modelType, 'expert')
  assert.equal(opts.resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro' }).modelType, 'expert')
  assert.equal(opts.resolveDeepSeekChatOptions({ model: 'deepseek-v4.1-flash' }).modelType, 'default')
})
check('Kimi 新模型回落到有效的 scenario', () => {
  for (const m of ['Kimi-K3', 'Kimi-K3.1', 'Kimi-K2.8-Preview', 'Kimi-K2.6']) {
    assert.equal(opts.resolveKimiScenario(m), 'SCENARIO_K2D6', m)
  }
  assert.equal(opts.resolveKimiScenario('Kimi-K2.5'), 'SCENARIO_K2D5')
})
check('Kimi 生成载荷带正确 scenario 与空 chat_id', () => {
  const p = opts.createKimiChatPayload({ model: 'Kimi-K3.1', content: 'hi', enableWebSearch: false, enableThinking: false })
  assert.equal(p.scenario, 'SCENARIO_K2D6')
  assert.equal(p.chat_id, '')
})

console.log('\n[3] 接线与既有配置兼容（静态）')

const read = (p) => readFileSync(join(SRC, p), 'utf8')
check('chat.ts 仍注入 conversationKey', () => {
  assert.match(read('proxy/routes/chat.ts'), /conversationRegistry\.resolveKey/)
})
check('store 合并内置模型，旧配置也能看到新模型', () => {
  assert.match(read('store/store.ts'), /mergedModels/)
})
check('仅 401/403/404 才清除远端会话绑定', () => {
  for (const f of ['deepseek', 'glm', 'kimi']) {
    const s = read(`proxy/adapters/${f}.ts`)
    assert.match(s, /401, 403, 404/, f)
  }
})

console.log(`\n结果: ${passed} 通过 / ${failures.length} 失败`)
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}
