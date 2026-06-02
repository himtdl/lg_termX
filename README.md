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
- ✅ **日志溯源**：自动记录所有命令和输出到 `log/` 目录，支持 ANSI 控制序列过滤
- ✅ **中文无乱码**：自动注入 UTF-8 编码切换 + GBK 兜底转码

---

## ✨ 功能特性

| 分类 | 工具数 | 说明 |
|------|--------|------|
| 终端生命周期 | 4 | `create_terminal` `kill_terminal` `rename_terminal` `kill_all_terminals` |
| 终端管理 | 3 | `select_terminal` `list_terminals` `get_current_terminal` |
| 命令与输出 | 4 | `send_command` `get_last_output` `get_all_output` `clear_output` |
| 配置与诊断 | 3 | `set_timeout` `get_terminal_info` `diagnose` |

**双引擎设计：**

| 引擎 | 适用场景 | 底层实现 |
|------|---------|---------|
| **PTY** (默认) | 本地 Windows 命令行 (`cmd` / `powershell`) | `node-pty` |
| **SSH2** | 远程 Linux/Windows 服务器 | `ssh2` 库 (纯 JS) |

---

## 🔧 环境要求与安装

### 前置条件

- **Node.js** >= 18.x
- **操作系统**：Windows 10/11（虽然理论支持跨平台，但当前仅 Windows 经过充分测试）

### 安装步骤

#### 1. 克隆项目

```bash
git clone https://github.com/himtdl/lg_termX.git
cd lg_termX
```

#### 2. 安装 `node-pty` 编译环境（重要！）

`node-pty` 是 C++ 原生模块，需要编译环境。在 Windows 上，你需要先安装以下之一：

**方法 A（推荐）：安装 Windows Build Tools**

以管理员身份打开 PowerShell 并运行：

```powershell
npm install --global windows-build-tools
```

**方法 B：安装 Visual Studio Build Tools**

1. 下载 [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
2. 安装时勾选「使用 C++ 的桌面开发」工作负载
3. 确保安装了 Windows 10/11 SDK

**额外要求：Python 3.x**

`node-gyp` 需要 Python 环境，请从 [python.org](https://www.python.org/downloads/) 下载安装，安装时勾选「Add Python to PATH」。

#### 3. 安装依赖

```bash
npm install
```

如果一切顺利，你会在输出中看到 `node-pty` 编译成功。

---

### MCP 客户端配置

在 Cline 或其他支持 MCP 的客户端中，添加如下配置：

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

---

## 🚨 安全警告（必读！）

### ⚠️ 让 AI 使用连续命令行是高风险操作！

`lg_termX` 赋予 AI 持久的命令行访问能力，AI 可以在终端会话中执行任意命令。请务必理解以下风险：

#### 🔴 极度危险：SSH 模式

当使用 SSH2 引擎连接远程服务器时：

- ❌ **绝不**向 AI 提供生产服务器的 SSH 凭据
- ❌ **绝不**在 AI 配置中使用 root 或高权限账户
- ❌ **绝不**使用来源不明、非官方的 API 或第三方中转服务
- ❌ **绝不**将 MCP 客户端配置文件（含密码）分享给他人或上传到公开仓库
- ✅ 仅在内网隔离环境、临时测试 VPS 或沙箱中使用 SSH 功能
- ✅ 使用前在 MCP 客户端中严格审查 AI 的每一步命令
- ✅ 建议使用 SSH 密钥认证代替密码（`ssh2` 支持 `privateKey` 配置）
- ✅ 及时清理不再使用的终端会话

> 🔴 **密码泄露后果**：任何通过此工具泄露的服务器账户密码，可能被用于完全控制你的服务器——包括但不限于数据窃取、勒索软件部署、挖矿木马植入。**后果不可逆！**

#### 🟡 本地 PTY 模式的风险

即使是本地终端，AI 也可能意外执行危险操作：

- 误删重要文件（`del /F /S /Q` 等）
- 修改系统配置导致系统不稳定
- 消耗大量系统资源（死循环、fork 炸弹等）

#### 📋 安全最佳实践

1. **最小权限原则**：为 AI 创建专用的低权限用户或受限 Shell
2. **命令审核**：每次 AI 执行命令前，确认命令内容是否合理
3. **环境隔离**：在虚拟机或容器中运行，与宿主机环境隔离
4. **及时终止**：任务完成后立即 `kill_terminal`，不要保留不必要的会话
5. **永不硬编码**：密码应通过安全的环境变量或密钥管理工具注入，不要直接写在配置文件中

---

## 📖 工具说明

### 终端生命周期

| 工具 | 描述 | 关键参数 |
|------|------|---------|
| `create_terminal` | 创建新终端（PTY 或 SSH2） | `name` `shell` `cwd` `ssh_config` `log_raw` |
| `kill_terminal` | 终止并删除指定终端 | `name` |
| `kill_all_terminals` | 一键终止所有终端 | — |
| `rename_terminal` | 重命名终端 | `old_name` `new_name` |

### 终端管理

| 工具 | 描述 | 关键参数 |
|------|------|---------|
| `select_terminal` | 切换当前操作终端 | `name` |
| `list_terminals` | 列出所有终端及状态 | — |
| `get_current_terminal` | 查看当前选中终端 | — |
| `get_terminal_info` | 获取终端详细信息（含日志路径） | `name`（可选） |
| `set_timeout` | 设置空闲超时（默认5分钟） | `name` `timeout_ms` |

### 命令与输出

| 工具 | 描述 | 关键参数 |
|------|------|---------|
| `send_command` | 向当前终端发送命令 | `command` `wait_ms` |
| `get_last_output` | 获取上一次命令的输出 | — |
| `get_all_output` | 获取自创建以来的全部输出 | — |
| `clear_output` | 清空输出缓冲区 | — |

### 诊断

| 工具 | 描述 | 关键参数 |
|------|------|---------|
| `diagnose` | 诊断运行环境（node-pty、SSH、PATH） | — |

---

## 📖 日志溯源

v1.0.3 新增日志功能，每次创建终端时自动在 `log/` 目录生成日志文件：

- 文件名格式：`{终端名称}_{YYYY-MM-DD_HH-mm-ss}.log`
- 记录所有发送的命令（`>>> 指令`）和接收的输出（`<<< 内容`）
- 默认过滤 ANSI 终端控制序列，日志清晰可读
- 如需保留原始字节流（调试 node-pty），设置 `create_terminal` 的 `log_raw = true`
- 终端关闭时自动写入关闭标记
- 可通过 `get_terminal_info` 获取 `logPath` 字段查看日志文件路径

**日志示例：**
```
[10:30:01] [lg_termX v1.0.3] 终端 "demo" 日志开始 (引擎: pty)
[10:30:01] >>> [系统] 注入UTF-8编码切换
[10:30:05] >>> dir C:\
[10:30:05] <<<  驱动器 C 中的卷是 Windows
 目录: C:\
2026/06/02  10:30    <DIR>        Windows
...
[10:31:00] [关闭] 终端 "demo" 日志结束
```

---

## 📁 项目结构

```
lg_termX/
├── index.js                # MCP 服务入口（14个工具注册）
├── terminal_manager.js     # 终端管理器（生命周期、超时扫描）
├── terminal_session.js     # 终端会话（双引擎实现 + 日志系统）
├── package.json
├── package-lock.json
├── README.md
├── CHANGELOG.md
├── LICENSE
└── log/                    # 日志目录（运行时自动创建）
    └── {name}_{时间}.log   # 终端操作溯源日志
```

---

## ⚠️ 已知限制

- **Windows 专用**：当前主要在 Windows 环境测试，Linux/macOS 下 `diagnose` 工具的 `where` 命令可能失效（不影响核心功能）
- **`node-pty` 编译要求**：Windows 必须安装 C++ 构建工具链
- **SSH 初始化等待**：SSH2 模式有 1.5 秒的固定初始化等待，极慢速网络下可能不够
- **输出截断**：`get_all_output` 默认截断 50,000 字符，长输出可能被裁剪

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。

```
Copyright © 2026 himtdl(老高)
Powered by laogaohome.top
老高之家 | 版权所有
```

---

## 🙏 致谢

- [Model Context Protocol](https://modelcontextprotocol.io/) — Anthropic 推出的 AI-工具标准协议
- [node-pty](https://github.com/microsoft/node-pty) — Microsoft 出品的伪终端库
- [ssh2](https://github.com/mscdex/ssh2) — 纯 JavaScript SSH2 客户端实现