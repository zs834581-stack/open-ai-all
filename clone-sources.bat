@echo off
REM ============================================================
REM  克隆上游源码到 src/ 并剥离嵌套 .git，便于作为私有仓库的一部分提交
REM  运行：双击本文件，或在 proxy-desktop 目录下执行 clone-sources.bat
REM  需要本机已安装 Git 且能访问 github.com
REM ============================================================
set BASE=src

echo 克隆 new-api（网关，Go）...
git clone --depth 1 https://github.com/QuantumNous/new-api.git %BASE%/new-api
rmdir /s /q %BASE%/new-api\.git

echo 克隆 5 个国产 free-api（Node）...
for %%p in (deepseek-free-api kimi-free-api qwen-free-api doubao-free-api glm-free-api) do (
  git clone --depth 1 https://github.com/LLM-Red-Team/%%p.git %BASE%/free-api/%%p
  rmdir /s /q %BASE%/free-api/%%p\.git
)

echo.
echo 完成。下一步：
echo   1. git add src 并提交（或让 CI 在构建时自动克隆）
echo   2. 改动源码进行二次开发
echo   3. 推送到你的 GitHub 私人仓库，Actions 会自动编译出 Windows exe
pause
