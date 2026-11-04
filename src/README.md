# src/ — 上游源码目录

本目录存放待二次开发的上游源码，**初始为空**。请运行根目录的克隆脚本拉取：

- Windows：双击 `clone-sources.bat`
- macOS/Linux：`bash clone-sources.sh`

拉取后结构：

```
src/
├── new-api/              # QuantumNous/new-api（Go 网关，可被 CI 编译为 new-api.exe）
└── free-api/
    ├── deepseek-free-api/
    ├── kimi-free-api/
    ├── qwen-free-api/
    ├── doubao-free-api/
    └── glm-free-api/
```

脚本会自动剥离各仓库的嵌套 `.git`，使其作为本仓库的一部分统一提交。
