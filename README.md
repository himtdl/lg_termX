# lg_termX — Windows AI 连续命令行工具

> 🖥️ **Windows 专用** | MCP 持久化终端服务器 | 双引擎（本地 PTY + 远程 SSH2）  
> 🏠 Powered by [laogaohome.top](https://laogaohome.top) | Copyright © 2026 himtdl(老高)

---

## 📖 简介

`lg_termX` 是一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的**持久化命令行终端服务器**。  

与普通单次命令执行工具不同，`lg_termX` 的核心能力是**维持终端会话**，这意味着：

- ✅ 支持 `cd`、`set` 等需要上下文的命令
- ✅ 一条命令的输出自动作为下一条命令的输入上下文
- ✅ 完美支持 SSH 登录后的连续操作（如交互式堡垒机跳转）
- ✅ 空闲自动关闭，安全可控
- ✅ **日志溯源**：自动记录所有命令和输出到 `log/` 目录，ANSI 过滤 + 容量保护
- ✅ **中文无乱码**：自动注入 UTF-8 编码切换 + GBK 兜底转码
- ✅ **控制键发送**：Ctrl+C、方向键、文本输入，打断卡死命令
- ✅ **异步执行**：大任务发完即返回，不阻塞 AI 等待

---

## ✨ 功能特性

| 分类 | 工具数 | 说明 |
|------|--------|------|
| 终端生命周期 | 4 | `create_terminal` `kill_terminal` `rename_terminal` `kill_all_terminals` |
| 终端管理 | 3 | `select_terminal` `list_terminals` `get_current_terminal` |
| 命令与输出 | 6 | `send_command` `send_command_async` `send_key` `get_last_output` `get_all_output` `clear_output` |
| 配置与诊断 | 3 | `set_timeout` `get_terminal_info` `diagnose` |

**双引擎设计：**

| 引擎 | 适用场景 | 底层实现 |
|------|---------|---------|
| **PTY** (默认) | 本地 Windows 命令行 | `node-pty` |
| **SSH2** | 远程 Linux/Windows 服务器 | `ssh2` 库 |

---

## 📖 核心工具速览

### `send_command_async` — 异步执行

适用于 `npm install`、`git clone`、构建等长时间任务，发完立即返回不等待：

```
send_command_async("npm install") → "命令已发送（异步执行）"
get_last_output()                → 轮询查看进度
```

### `send_key` — 控制键

打断卡死命令（`top`/`ping`/`tail -f`）：

```
send_command("top", wait_ms=2000) → 超时
send_key("ctrl+c")                → 发送 Ctrl+C 打断
```

### `send_command` — 同步执行

支持 `timeout_ms` 控制最长等待时间，返回值自动截断 5000 字符防 token 爆炸。

---

## 🔧 环境要求与安装

- **Node.js** >= 18.x
- **操作系统**：Windows 10/11

```bash
git clone https://github.com/himtdl/lg_termX.git
cd lg_termX
npm install
```

### MCP 客户端配置

```json
{
  "mcpServers": {
    "lg_termX": {
      "command": "node",
      "args": ["C:/Users/你的用户名/Documents/Cline/MCP/lg_termX/index.js"]
    }
  }
}
```

> ⚠️ MCP 客户端默认 `timeout: 60`。长时间任务请使用 `send_command_async`。

---

## 📖 日志溯源

每次创建终端自动生成 `log/{name}_{时间}.log`：
- 记录所有 `>>>` 命令和 `<<<` 输出
- 默认过滤 ANSI 控制序列，清晰可读
- `log_raw = true` 保留原始字节流
- 完整输出见日志文件，MCP 返回值有 5000 字符截断保护

---

## 📁 项目结构

```
lg_termX/
├── index.js                # MCP 服务入口（16个工具）
├── terminal_manager.js     # 终端管理器
├── terminal_session.js     # 终端会话（双引擎 + 日志 + 输出保护）
├── package.json
├── README.md / CHANGELOG.md / LICENSE
└── log/                    # 运行时自动创建
```

---

## 📄 许可证

MIT License | Copyright © 2026 himtdl(老高) | Powered by laogaohome.top