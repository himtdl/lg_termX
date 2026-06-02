# CHANGELOG

## [1.0.5] - 2026-06-02

### 新增
- `send_command_async` 工具（第 16 个工具）：异步发送命令，立即返回不等待结果
  - 适用于 `npm install`、`git clone`、构建、下载等长时间任务
  - 发送后可通过 `get_last_output`/`get_all_output` 轮询结果
- `send_command` 新增 `timeout_ms` 参数：覆盖默认超时（PTY 30s / SSH2 60s）
- 输出容量保护（防止 `top`/`ping` 等无限输出撑爆内存/Token）：
  - PTY `outputBuffer` 上限 200 条目，超出自动丢弃前半
  - SSH2 `_sshStdout` 上限 100KB，超出保留后半
  - 命令返回值上限 5000 字符，超出截断并提示查看日志

### 修复
- SSH2 `send_command` 超时时保存中途输出到 `outputBuffer`（不再丢弃）
- `package.json` keywords 扩充为 14 个

## [1.0.4] - 2026-06-02

### 新增
- `send_key` 工具（第 15 个工具）：向终端发送控制键/组合键/文本

## [1.0.3] - 2026-06-02

### 新增
- 日志 ANSI 过滤 + `log_raw` 参数

## [1.0.2] - 2026-06-02

### 修复
- PTY 引擎中文 GBK 乱码

### 新增
- 日志溯源 (`log/` 目录) + 工具描述强约束

## [1.0.0] - 2026-06-01

### 新增
- 首次发布：PTY + SSH2 双引擎 + 14 个工具