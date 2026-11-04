# proxy-desktop

本地 AI 网关一键包：把 **new-api**（聚合网关 + Web 控制台）与 **5 个国产免费模型网页端逆向服务**（free-api）封装成一个 Windows 可执行程序 / 服务，并在桌面浏览器通过 Web 页面配置。

> 形态：**免 Docker 原生 exe**（new-api 为 Go 预编译 exe，free-api 为 Node 服务，proxipt/Playwright 不在本包内）。
> 仅供个人学习研究，逆向网页端请遵守各平台 ToS，禁止对外商用。

---

## 目录结构

```
proxy-desktop/
├── launcher/                 # Node 启动器（打包为 launcher.exe）
│   ├── launcher.js           #   拉起 new-api + free-api，打开 Web 控制台
│   ├── config.json           #   端口 / 路径 / 启用的服务
│   └── package.json          #   pkg 打包配置
├── src/                      # 上游源码（clone-sources 拉取，可二次开发）
│   ├── new-api/              #   QuantumNous/new-api（Go 网关）
│   └── free-api/             #   5 个 LLM-Red-Team 的 *-free-api（Node）
├── .github/workflows/
│   └── build.yml             # GitHub Actions：推送到私人仓库后自动编译 Windows exe
├── clone-sources.bat / .sh   # 一键克隆上游源码到 src/
└── README.md
```

## 本地二次开发流程

1. **拉取上游源码**（本机需能访问 github.com，且装了 Git）：
   - Windows：双击 `clone-sources.bat`
   - macOS/Linux：`bash clone-sources.sh`
   - 脚本会把 new-api 与 5 个 free-api 克隆进 `src/`，并剥离嵌套 `.git`，方便作为本仓库的一部分提交。
2. **改动源码**：在 `src/new-api`、`src/free-api/*` 中修改，进行二次开发。
3. **本地验证**（可选）：
   - 网关：`cd src/new-api && go run .`（默认 3000 端口）
   - 免费模型：在各 `src/free-api/<name>` 中 `npm install && npm start`
   - 启动器：本机装好 Node 22 后 `cd launcher && npm install && node launcher.js start`
4. **打包为 exe**（可选，也可直接让 CI 打包）：
   ```
   cd launcher && npm install && npm run build
   ```
   产物为 `launcher/dist/launcher.exe`（需把 `new-api.exe` 与 `free-api/` 一并放入同目录）。

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
   - 为各 free-api 安装依赖
   - 用 `pkg` 把启动器打包成 `launcher.exe`
   - 汇总到 `dist/` 并上传为 **artifact**（压缩包）。
4. 在 Actions 运行结果页下载 `proxy-desktop-windows` 压缩包，解压后：
   - 双击 `launcher.exe` → 自动启动网关与各服务，并打开 `http://localhost:3000` 的 Web 控制台。
   - 或在解压目录执行 `launcher.exe install-service` 注册为 Windows 服务（需先 `npm install node-windows`）。

## 配置说明（launcher/config.json）

- `newApi.port`：网关 Web 控制台端口（默认 3000）。
- `freeApis[].port`：各免费模型服务端口（8001–8005），避免冲突。
- `freeApis[].enabled`：设为 `false` 可临时关闭某个服务。
- 各免费模型需在 new-api 控制台建渠道时填入对应平台的 **Cookie / Token**（详见各 free-api 仓库说明）。

## 免责声明

- new-api、各 free-api 均为第三方开源项目，版权归原作者。
- 网页端逆向可能违反对应平台服务条款，请仅用于个人学习，勿对外提供服务或商用。
- 免费层有速率限制，生产场景请使用官方 API。
