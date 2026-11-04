@echo off
REM ============================================================
REM  克隆上游源码到 src/ 并剥离嵌套 .git，便于作为私有仓库的一部分提交
REM  运行：双击本文件，或在 proxy-desktop 目录下执行 clone-sources.bat
REM  需要本机已安装 Git 且能访问 github.com
REM
REM  ⚠️ 本包定位：把各厂家「网页端/客户端」转换为标准 OpenAI API（转换层）
REM     + new-api 做聚合/Web 配置层。
REM  ⚠️ 原 LLM-Red-Team 组织已被 GitHub 封号下架，其 *-free-api 全部 404，
REM     且原代码被植入混淆恶意代码（供应链攻击），严禁使用。
REM  ⚠️ 以下地址为 2026-11 核实仍在 github.com 可访问的版本。
REM ============================================================
set BASE=src

echo 克隆 new-api（聚合/Web 配置网关，Go）...
git clone --depth 1 https://github.com/QuantumNous/new-api.git %BASE%/new-api
if exist %BASE%/new-api\.git rmdir /s /q %BASE%/new-api\.git

echo.
echo 克隆「主转换层」Chat2API（Electron 桌面 + Web Dashboard，覆盖 DeepSeek/GLM/Kimi/Qwen，免 Docker）...
git clone --depth 1 https://github.com/xiaoY233/Chat2API.git %BASE%/chat2api
if exist %BASE%/chat2api\.git rmdir /s /q %BASE%/chat2api\.git

echo.
echo ============================================================
echo  备选转换层（按需取消注释后克隆）：
echo    openclaw-zero-token（12 平台含豆包/ChatGPT/Claude/Gemini，需 Chrome CDP）:
echo      git clone --depth 1 https://github.com/linuxhsj/openclaw-zero-token.git %BASE%/openclaw-zero-token
echo    proXiPT（23+ 平台，Python+Playwright，需 Docker）:
echo      git clone --depth 1 https://github.com/junseo2323/proXiPT.git %BASE%/proxipt
echo    独立清理版（仅 DeepSeek / GLM）:
echo      git clone --depth 1 https://github.com/Fu-Jie/deepseek-free-api.git %BASE%/free-api/deepseek-free-api
echo      git clone --depth 1 https://github.com/evanoooo/GLM-Free-API.git %BASE%/free-api/glm-free-api
echo ============================================================
echo.
echo 完成。下一步：
echo   1. git add src 并提交
echo   2. 在 src/ 下做二次开发（转换层逻辑 / 网关定制）
echo   3. 推送到你的 GitHub 私人仓库，Actions 会自动编译 Windows exe
pause
