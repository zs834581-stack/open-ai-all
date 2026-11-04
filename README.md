# proxy-desktop

本地 AI 网关一键包：把各厂家的**网页端 / 客户端服务转换为标准 OpenAI API（转换层）**，再经 **new-api**（聚合网关 + Web 控制台）统一出口，最终在桌面浏览器通过 Web 页面配置，并封装为 Windows 可执行程序 / 服务。

> 形态：**免 Docker 原生优先**（Chat2API 为 Electron 桌面应用，自带 Web Dashboard，可直接出 Windows 安装包；new-api 为 Go 预编译 exe）。
> 仅供个人学习研究。逆向 / 转换网页端违反各平台 ToS，禁止对外商用。

---

## ⚠️ 重要安全变更（2026-11）

- 原 `LLM-Red-Team` 组织已被 GitHub 封号下架，其 `*-free-api` **全部 404**。
- 原仓库代码被植入**混淆恶意代码（供应链攻击）**，严禁再使用。
- 因此本包**不再依赖分散的 free-api 逆向项目**，改为使用仍在维护且已清理的转换层（见下）。

## 需要下载的上游项目地址（github.com 可访问）

### 聚合 / Web 配置层（网关，必下）
- **new-api**：`https://github.com/QuantumNous/new-api`（Go，自带 Web 控制台，把多个转换层聚合成统一 OpenAI 出口）

### 转换层（把各厂家网页/客户端转 API，按需下载）
**统一转换网关（一个项目转多个厂家，推荐）：**
- **Chat2API**：`https://github.com/xiaoY233/Chat2API` ✅ 主推。Electron 桌面 + 自带 Web Dashboard，覆盖 **DeepSeek / GLM / Kimi / MiniMax / Qwen / Z.ai**，免 Docker，支持多账号负载均衡、Function Calling，`npm run build:win` 出 Windows 包。
- **openclaw-zero-token**：`https://github.com/linuxhsj/openclaw-zero-token` ✅ 用 Playwright + Chrome CDP 读浏览器 Cookie 转 API，覆盖 12 平台（含 **豆包 / ChatGPT / Claude / Gemini**）。⚠️ 上游 OpenClaw 有 CVE，部署需注意安全。
- **proXiPT**：`https://github.com/junseo2323/proXiPT` ✅ Python + Playwright，23+ 平台，需 Docker。

**独立清理版（仅还在维护的）：**
- **DeepSeek**：`https://github.com/Fu-Jie/deepseek-free-api` ✅
- **GLM 智谱**：`https://github.com/evanoooo/GLM-Free-API` ✅（或 `beyond-motion/GLM-Free-API`、`xiaoY233/GLM-Free-API`）

> Kimi / Qwen / 豆包 的独立逆向版已失效 / 不安全，请用上面的统一网关替代。下载任何转换层源码后**务必审查源码**。

---

## 目录结构

```
proxy-desktop/
├── launcher/                 # Node 启动器（打包为 launcher.exe，拉起网关并打开 Web 控制台）
│   ├── launcher.js
│   ├── config.json
│   └── package.json
├── src/                      # 上游源码（clone-sources 拉取，可二次开发）
│   ├── new-api/              #   QuantumNous/new-api（Go 网关）
│   ├── chat2api/             #   xiaoY233/Chat2API（主转换层，Electron）
│   └── free-api/             #   （可选）清理版 deepseek-free-api / glm-free-api
├── .github/workflows/
│   └── build.yml             # GitHub Actions：推送到私人仓库后自动编译 Windows exe
├── clone-sources.bat / .sh   # 一键克隆上游源码到 src/（地址已更新为上面清单）
└── README.md
```

## 推荐架构

```
各厂家网页端 / 客户端（Cookie / 登录态）
        │
        ▼
 Chat2API（主转换层，自带 Dashboard，免 Docker，覆盖国产主力）
 openclaw-zero-token（补 豆包 / ChatGPT / Claude / Gemini，需 Chrome）
        │  各自暴露 OpenAI 兼容 API
        ▼
 new-api（聚合 + 路由 + 计费 + Web 控制台，统一 :3000 出口）
        │
        ▼
 OpenCode / WorkBuddy / Cursor / Cline / Dify
```

最简版：只用 **Chat2API**（自带 Dashboard + OpenAI API 出口），直接喂给 Agent；要聚合 / 多后端 / 计费时再加 new-api。

## 本地二次开发流程

1. **拉取上游源码**（本机需能访问 github.com 且装 Git）：
   - Windows：双击 `clone-sources.bat`（已更新为上面清单中的真实地址）
   - macOS/Linux：`bash clone-sources.sh`
2. **改动源码**：在 `src/new-api`、`src/chat2api` 等目录中修改，做二次开发。
3. **本地验证**（可选）：
   - 网关：`cd src/new-api && go run .`（默认 3000 端口）
   - 转换层：参考各项目 README（Chat2API 用 `npm install && npx electron-vite dev`）
   - 启动器：本机装好 Node 22 后 `cd launcher && npm install && node launcher.js start`
4. **打包为 exe**（可选，也可直接让 CI 打包）：
   ```
   cd launcher && npm install && npm run build
   ```
   产物为 `launcher/dist/launcher.exe`。

## 推送到私人仓库并自动编译

1. 在 GitHub 新建一个 **Private** 仓库。
2. 本机初始化并提交（本脚手架已 `git init`）：
   ```
   git remote add origin git@github.com:<你>/<仓库>.git
   git add .
   git commit -m "init proxy-desktop"
   git push -u origin main
   ```
3. 推送后，仓库的 **Actions → Build Windows Release** 会自动：
   - 用 Go 编译 `new-api.exe`
   - 用 `pkg` 把启动器打包成 `launcher.exe`
   - 汇总到 `dist/` 并上传为 **artifact**（压缩包）。
4. 在 Actions 运行结果页下载 `proxy-desktop-windows` 压缩包，解压后：
   - 双击 `launcher.exe` → 自动启动网关并打开 `http://localhost:3000` 的 Web 控制台。
   - 或在解压目录执行 `launcher.exe install-service` 注册为 Windows 服务（需先 `npm install node-windows`）。

## 配置说明（launcher/config.json）

- `newApi.port`：网关 Web 控制台端口（默认 3000）。
- 转换层（Chat2API 等）按各自 README 配置端口与账号；在 new-api 控制台建「自定义(OpenAI 兼容)」渠道，Base URL 填转换层地址，密钥填转换层生成的 key。

## 免责声明

- new-api、Chat2API、openclaw-zero-token、proXiPT 及各 free-api 均为第三方开源项目，版权归原作者。
- 逆向 / 转换网页端可能违反对应平台服务条款，请仅用于个人学习，勿对外提供服务或商用。
- 原 `LLM-Red-Team` 代码含供应链攻击恶意代码，本包已避开；下载其他转换层源码后请审查。
- 免费层有速率限制，生产场景请使用官方 API。
