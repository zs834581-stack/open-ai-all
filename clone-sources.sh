#!/usr/bin/env bash
# 克隆上游源码到 src/ 并剥离嵌套 .git，便于作为私有仓库的一部分提交
# 需要本机已安装 git 且能访问 github.com
set -e
BASE=src

echo "克隆 new-api（网关，Go）..."
git clone --depth 1 https://github.com/QuantumNous/new-api.git "$BASE/new-api"
rm -rf "$BASE/new-api/.git"

echo "克隆 5 个国产 free-api（Node）..."
for p in deepseek-free-api kimi-free-api qwen-free-api doubao-free-api glm-free-api; do
  git clone --depth 1 "https://github.com/LLM-Red-Team/$p.git" "$BASE/free-api/$p"
  rm -rf "$BASE/free-api/$p/.git"
done

echo "完成。下一步：git add src 并提交，或让 CI 在构建时自动克隆。"
