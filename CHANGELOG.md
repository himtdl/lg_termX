# CHANGELOG

## [1.0.3] - 2026-06-02

### 新增
- 日志 ANSI 过滤：默认通过 `stripAnsi()` 过滤终端控制序列（CSI/OSC 转义码），日志可读性大幅提升
- `create_terminal` 新增 `log_raw` 参数（默认 `false`），设为 `true` 时保留原始字节流（用于调试 node-pty）

### 修改
- `terminal_manager.js`：PTY 创建逻辑兼容新调用格式（`{ engine: "pty", ... }` 对象）

## [1.0.2] - 2026-06-02

### 修复
- PTY 引擎中文乱码：Windows cmd.exe 默认 GBK (CP936) 编码自动转 UTF-8
  - 启动终端时注入 `chcp 65001 > nul` (cmd) 或 `$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8` (powershell)
  - `onData` 回调增加兜底检测：非法 UTF-8 字符自动回退 `TextDecoder('gbk')` 解码

### 新增
- 日志溯源：每个终端启动时自动在 `log/` 目录创建 `{name}_{YYYY-MM-DD_HH-mm-ss}.log` 日志文件
  - 记录所有发送的命令 (`>>> 指令`) 和接收的输出 (`<<< 内容`)
  - 终端关闭时自动写入关闭标记并关闭日志流
  - `getInfo()` / `get_terminal_info` 工具新增 `logPath` 字段，可查看日志文件路径
- 工具描述强约束：`create_terminal` 和 `send_command` 的 description 追加 ⚠️ 提醒，要求 AI 使用完毕后必须关闭终端

## [1.0.0] - 2026-06-01

### 新增
- 首次发布：PTY + SSH2 双引擎终端管理 MCP 服务
- 14 个工具：create_terminal, select_terminal, list_terminals, kill_terminal, set_timeout, send_command, get_last_output, get_all_output, clear_output, get_current_terminal, rename_terminal, get_terminal_info, diagnose, kill_all_terminals
- 支持空闲超时自动回收（默认 5 分钟）