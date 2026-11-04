#!/usr/bin/env node
/**
 * proxy-desktop launcher
 * 拉起 new-api.exe（聚合网关 + Web 控制台）与 Chat2API（主转换层：把各厂家网页/客户端转 OpenAI API，自带 Dashboard），
 * 并打开 Web 控制台。可选拉起清理版 Node 转换服务（如 deepseek/glm free-api）。
 * 用 pkg 打包成单文件 exe；用 node-windows 可注册为 Windows 服务。
 *
 * 路径约定（打包后的 dist 目录）：
 *   ./new-api.exe
 *   ./chat2api/Chat2API.exe        （由 Chat2API 源码 build:win 产出并放入）
 *   ./free-api/<name>/             （可选，清理版 Node 转换服务）
 *   ./config.json
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

// pkg 打包后 __dirname 指向虚拟快照（C:\snapshot\launcher），
// 真实可执行文件与同级资源目录在 process.execPath 所在目录。
const IS_PKG = typeof process.pkg !== 'undefined';
const APP_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
// 所有相对资源（new-api.exe / chat2api / data / free-api）都以 APP_DIR 为基准
const ROOT = APP_DIR;

// 优先读取 exe / 脚本同目录的外部 config.json（打包后可直接修改），
// 不存在时回退到打包内嵌的配置。
const EXTERNAL_CONFIG = path.join(APP_DIR, 'config.json');
const CONFIG_PATH = fs.existsSync(EXTERNAL_CONFIG)
  ? EXTERNAL_CONFIG
  : path.join(__dirname, 'config.json');

const procs = new Map();

/** 递归创建目录，返回是否可用（打包后目录可能缺失，需自愈） */
function ensureDir(dir, label) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    console.error(`无法创建${label || '目录'} ${dir}: ${e.message}`);
    return false;
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('找不到 config.json，请确认与 launcher.exe 同目录。');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function log(name, msg) {
  console.log(`[${name}] ${msg}`);
}

function pipe(name, stream) {
  if (!stream) return;
  stream.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
}

function startNewApi(cfg) {
  const exe = path.resolve(ROOT, cfg.newApi.exePath);
  if (!fs.existsSync(exe)) {
    console.error(
      `new-api 可执行文件不存在: ${exe}\n` +
      `请确认 new-api.exe 与 launcher.exe 在同一目录（当前基准目录: ${ROOT}）。`
    );
    return null;
  }
  const args = [];
  if (cfg.newApi.port) args.push('--port', String(cfg.newApi.port));
  // new-api 以 dataDir 为工作目录存放数据库/日志，目录不存在会导致启动失败 → 先自愈创建
  const dataDir = path.resolve(ROOT, cfg.newApi.dataDir || './data');
  if (!ensureDir(dataDir, ' new-api 数据目录')) return null;
  const child = spawn(exe, args, {
    cwd: dataDir,
    env: { ...process.env, ...(cfg.newApi.env || {}), PORT: String(cfg.newApi.port || 3000) },
    windowsHide: true,
  });
  pipe('new-api', child.stdout);
  pipe('new-api', child.stderr);
  child.on('exit', (code) => log('new-api', `进程退出 code=${code}`));
  return child;
}

function startChat2Api(cfg) {
  const c = cfg.chat2api;
  if (!c || c.enabled === false) return null;
  const exe = path.resolve(ROOT, c.exePath);
  if (!fs.existsSync(exe)) {
    console.error(
      `Chat2API 可执行文件不存在: ${exe}\n` +
      `请确认 chat2api\\Chat2API.exe 与 launcher.exe 的相对位置正确（当前基准目录: ${ROOT}）。\n` +
      `也可设 chat2api.enabled=false，手动双击运行 Chat2API。`
    );
    return null;
  }
  // Chat2API 是带 GUI 的桌面应用，需显示窗口供配置，故不隐藏。
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    windowsHide: false,
  });
  pipe('chat2api', child.stdout);
  pipe('chat2api', child.stderr);
  child.on('exit', (code) => log('chat2api', `进程退出 code=${code}`));
  return child;
}

function startNodeService(svc) {
  const dir = path.resolve(ROOT, svc.dir);
  if (!fs.existsSync(dir)) {
    console.error(`Node 转换服务目录不存在: ${dir}\n请确认 dist/free-api 已包含该服务。`);
    return null;
  }
  const child = spawn(svc.cmd || 'npm start', [], {
    cwd: dir,
    shell: true,
    env: { ...process.env, PORT: String(svc.port) },
    windowsHide: true,
  });
  pipe(svc.name, child.stdout);
  pipe(svc.name, child.stderr);
  child.on('exit', (code) => log(svc.name, `进程退出 code=${code}`));
  return child;
}

function startAll(cfg) {
  log('launcher', '启动中…');
  const na = startNewApi(cfg);
  if (na) procs.set('new-api', na);

  const ca = startChat2Api(cfg);
  if (ca) procs.set('chat2api', ca);

  for (const svc of cfg.nodeServices || []) {
    if (svc.enabled === false) continue;
    const c = startNodeService(svc);
    if (c) procs.set(svc.name, c);
  }

  if (cfg.autoOpenWebUI) {
    setTimeout(() => openWebUI(cfg.newApi.port || 3000, cfg.webUIPath || '/'), 2500);
  }
}

function stopAll() {
  for (const [name, c] of procs) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/f', '/t']);
      else c.kill('SIGTERM');
    } catch (e) {}
    log(name, '已请求停止');
  }
  procs.clear();
}

function openWebUI(port, p) {
  const url = `http://localhost:${port}${p || '/'}`;
  log('launcher', `打开 Web 控制台: ${url}`);
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { windowsHide: true });
  else if (process.platform === 'darwin') spawn('open', [url]);
  else spawn('xdg-open', [url]);
}

function checkPort(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(1000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

async function showStatus(cfg) {
  const port = cfg.newApi.port || 3000;
  const up = await checkPort(port);
  console.log(`new-api  Web 控制台 (${up ? '运行中' : '未运行'}): http://localhost:${port}`);
  const c = cfg.chat2api;
  if (c && c.enabled !== false) {
    const s = await checkPort(c.port || 8080);
    console.log(`chat2api 转换层+Dashboard (${s ? '监听中' : '未监听'}): 端口 ${c.port || 8080}`);
  }
  for (const svc of cfg.nodeServices || []) {
    if (svc.enabled === false) continue;
    const s = await checkPort(svc.port);
    console.log(`node ${svc.name.padEnd(16)} 端口 ${svc.port} (${s ? '监听中' : '未监听'})`);
  }
}

function installService() {
  let nodeWindows;
  try { nodeWindows = require('node-windows'); }
  catch (e) { console.error('未安装 node-windows，请先: npm install node-windows（服务注册为可选项）'); process.exit(1); }
  const Service = nodeWindows.Service;
  const svc = new Service({
    name: 'ProxyDesktop',
    description: '本地 AI 网关：new-api（聚合/Web 控制台）+ Chat2API 转换层',
    // 打包后没有 launcher.js，服务直接指向 exe 自身
    script: IS_PKG ? process.execPath : path.join(__dirname, 'launcher.js'),
  });
  svc.on('install', () => { log('service', '已安装，正在启动…'); svc.start(); });
  svc.on('alreadyinstalled', () => log('service', '已经安装过了'));
  svc.on('error', (e) => log('service', `错误: ${e.message || e}`));
  svc.install();
}

function uninstallService() {
  let nodeWindows;
  try { nodeWindows = require('node-windows'); }
  catch (e) { console.error('未安装 node-windows，请先: npm install node-windows（服务注册为可选项）'); process.exit(1); }
  const Service = nodeWindows.Service;
  const svc = new Service({ name: 'ProxyDesktop', script: IS_PKG ? process.execPath : path.join(__dirname, 'launcher.js') });
  svc.on('uninstall', () => log('service', '已卸载'));
  svc.on('error', (e) => log('service', `错误: ${e.message || e}`));
  svc.uninstall();
}

function main() {
  const cmd = process.argv[2] || 'start';
  const cfg = loadConfig();
  switch (cmd) {
    case 'start': startAll(cfg); break;
    case 'stop': stopAll(); process.exit(0);
    case 'restart': stopAll(); setTimeout(() => startAll(cfg), 600); break;
    case 'status': showStatus(cfg).then(() => process.exit(0)); return;
    case 'open': openWebUI(cfg.newApi.port || 3000, cfg.webUIPath || '/'); process.exit(0);
    case 'install-service': installService(); return;
    case 'uninstall-service': uninstallService(); return;
    default:
      console.log('用法: launcher.exe [start|stop|restart|status|open|install-service|uninstall-service]');
      process.exit(1);
  }
  process.on('SIGINT', () => { stopAll(); process.exit(0); });
  process.on('SIGTERM', () => { stopAll(); process.exit(0); });
  process.on('exit', () => stopAll());
}

main();
