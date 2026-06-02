/**
 *
 *  Project: lg_termX
 *  Name: index.js
 *  Type: MCP Server - 终端管理 MCP 服务入口
 *  Description: 提供持久化终端管理能力，支持多终端、空闲超时、SSH 等连续交互场景
 *  Author: himtdl(老高)
 *  Date: 2026/6/1
 *  Powered by laogaohome.top
 *  Copyright © 2026 himtdl. All rights reserved.
 *
 *  老高之家 | 版权所有
 *
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TerminalManager } from "./terminal_manager.js";

// ============================================================
// 初始化
// ============================================================

const manager = new TerminalManager();

const server = new McpServer({
  name: "lg_termX",
  version: "1.0.5",
});

// ============================================================
// 工具 1: create_terminal — 创建新终端
// ============================================================
server.registerTool(
  "create_terminal",
  {
    title: "创建终端",
    description:
      "创建一个新的持久化终端会话。PTY 模式（默认）：本地 cmd/powershell；SSH2 模式：通过 ssh2 库连接远程主机（支持密码认证）。默认空闲5分钟后自动关闭。\n⚠️ 使用完毕后务必调用 kill_terminal 关闭终端，避免资源泄漏和内存占用。",
    inputSchema: {
      name: z
        .string()
        .describe("终端名称，用于后续选择和操作，必须唯一"),
      shell: z
        .string()
        .optional()
        .default("cmd.exe")
        .describe("Shell 类型（PTY 模式）：cmd.exe/powershell.exe 等。如果提供 ssh_config，此参数被忽略"),
      cwd: z
        .string()
        .optional()
        .describe("工作目录（仅PTY模式）"),
      log_raw: z
        .boolean()
        .optional()
        .default(false)
        .describe("是否在日志中保留原始 ANSI 控制序列（默认 false 即过滤，调试 node-pty 时可设为 true）"),
      ssh_config: z
        .object({
          host: z.string(),
          port: z.number().optional().default(22),
          username: z.string(),
          password: z.string(),
        })
        .optional()
        .describe("SSH 连接配置（SSH2 模式）。提供此参数时忽略 shell/cwd，使用 ssh2 库连接"),
    },
    outputSchema: {
      name: z.string(),
      shell: z.string(),
      engine: z.string(),
      cwd: z.string().nullable(),
      pid: z.number().nullable(),
      isRunning: z.boolean(),
      timeoutMs: z.number(),
      idleTime: z.number(),
      uptime: z.number(),
      createdAt: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (args) => {
    try {
      let configOrShell;
      if (args.ssh_config) {
        configOrShell = {
          engine: "ssh2",
          host: args.ssh_config.host,
          port: args.ssh_config.port || 22,
          username: args.ssh_config.username,
          password: args.ssh_config.password,
          logRaw: args.log_raw || false,
        };
      } else {
        configOrShell = {
          engine: "pty",
          shell: args.shell || "cmd.exe",
          logRaw: args.log_raw || false,
        };
      }
      const cwd = args.ssh_config ? null : (args.cwd || null);
      const info = await manager.createTerminal(args.name, configOrShell, cwd);
      const text =
        `终端 "${args.name}" 创建成功\n` +
        `引擎: ${info.engine}\n` +
        `Shell: ${info.shell}\n` +
        `PID: ${info.pid || "N/A"}\n` +
        `空闲超时: ${info.timeoutMs === -1 ? "永不超时" : info.timeoutMs + "ms"}\n` +
        `当前选中终端: ${manager.currentName}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: info,
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `创建终端失败: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 2: select_terminal — 选择当前终端
// ============================================================
server.registerTool(
  "select_terminal",
  {
    title: "选择终端",
    description:
      "选择/切换当前操作的终端。后续 send_command 等操作都将针对此终端。",
    inputSchema: {
      name: z.string().describe("要选择的终端名称"),
    },
    outputSchema: {
      name: z.string().nullable(),
      info: z.any().nullable(),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const result = manager.selectTerminal(args.name);
      return {
        content: [
          {
            type: "text",
            text: `已切换到终端 "${args.name}"`,
          },
        ],
        structuredContent: result,
      };
    } catch (e) {
      const terminals = manager.listTerminals();
      const names = terminals.map((t) => `"${t.name}"`).join(", ") || "(无)";
      return {
        content: [
          {
            type: "text",
            text: `切换失败: ${e.message}\n可用终端: ${names}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 3: list_terminals — 列出所有终端
// ============================================================
server.registerTool(
  "list_terminals",
  {
    title: "列出所有终端",
    description:
      "获取当前所有的终端名称及其状态。当前选中的终端会标记为 '*'。",
    inputSchema: {},
    outputSchema: z.array(
      z.object({
        name: z.string(),
        shell: z.string(),
        pid: z.number().nullable(),
        isRunning: z.boolean(),
        isCurrent: z.boolean(),
        idleTime: z.number(),
        uptime: z.number(),
      })
    ),
    annotations: { readOnlyHint: true },
  },
  async () => {
    const list = manager.listTerminals();
    if (list.length === 0) {
      return {
        content: [{ type: "text", text: "当前没有终端" }],
        structuredContent: [],
      };
    }
    const lines = list.map((t) => {
      const prefix = t.isCurrent ? " * " : "   ";
      const status = t.isRunning ? "运行中" : "已停止";
      const idle = t.isRunning
        ? `空闲: ${Math.round(t.idleTime / 1000)}s`
        : "";
      return `${prefix}${t.name}  [${t.shell}]  PID:${t.pid || "N/A"}  ${status}  ${idle}`;
    });
    const text = "终端列表:\n" + lines.join("\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: list,
    };
  }
);

// ============================================================
// 工具 4: kill_terminal — 终止指定终端
// ============================================================
server.registerTool(
  "kill_terminal",
  {
    title: "终止终端",
    description: "终止并删除指定名称的终端进程。",
    inputSchema: {
      name: z.string().describe("要终止的终端名称"),
    },
    outputSchema: { success: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async (args) => {
    try {
      await manager.killTerminal(args.name);
      return {
        content: [
          {
            type: "text",
            text: `终端 "${args.name}" 已终止${manager.currentName ? `，当前终端: "${manager.currentName}"` : "，当前无选中终端"}`,
          },
        ],
        structuredContent: { success: true },
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `终止失败: ${e.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 5: set_timeout — 设置终端空闲超时
// ============================================================
server.registerTool(
  "set_timeout",
  {
    title: "设置空闲超时",
    description:
      "设置指定终端的空闲自动关闭时间。默认 300000ms（5分钟）。设为 -1 表示永不自动关闭。",
    inputSchema: {
      name: z.string().describe("终端名称"),
      timeout_ms: z
        .number()
        .describe("超时毫秒数，-1 表示永不自动关闭"),
    },
    outputSchema: { success: z.boolean(), timeoutMs: z.number() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (args) => {
    try {
      manager.setTimeout(args.name, args.timeout_ms);
      const display =
        args.timeout_ms === -1
          ? "永不超时"
          : `${Math.round(args.timeout_ms / 1000)}秒`;
      return {
        content: [
          {
            type: "text",
            text: `终端 "${args.name}" 空闲超时已设为: ${display}`,
          },
        ],
        structuredContent: { success: true, timeoutMs: args.timeout_ms },
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `设置失败: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 6: send_command — 向当前终端发送命令
// ============================================================
server.registerTool(
  "send_command",
  {
    title: "发送命令",
    description:
      "向当前选中的终端发送一条命令，等待指定时间后返回命令输出。适用于需要连续交互的场景（如 SSH 登录后逐步输入命令）。\n⚠️ 命令执行完毕后请调用 kill_terminal 或 kill_all_terminals 清理终端会话，不要保留空闲终端。",
    inputSchema: {
      command: z.string().describe("要执行的命令"),
      wait_ms: z
        .number()
        .optional()
        .default(2000)
        .describe("发送后等待时间（毫秒），等待命令执行出结果。对于耗时操作可增大此值"),
      timeout_ms: z
        .number()
        .optional()
        .describe("超时时间（毫秒）。超过此时间强制返回，覆盖默认 60s(SSH2)/30s(PTY)。设 0 或不传使用默认值"),
    },
    outputSchema: { output: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (args) => {
    try {
      const output = await manager.sendToCurrent(args.command, args.wait_ms, args.timeout_ms || null);
      return {
        content: [{ type: "text", text: output }],
        structuredContent: { output },
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `命令发送失败: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 7: send_command_async — 异步发送命令
// ============================================================
server.registerTool(
  "send_command_async",
  {
    title: "异步发送命令",
    description:
      "向当前终端发送命令，立即返回不等待执行结果。适用于 npm install、git clone、构建、下载等长时间任务。完成后可通过 get_last_output/get_all_output 轮询结果。",
    inputSchema: {
      command: z.string().describe("要异步执行的命令"),
    },
    outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (args) => {
    try {
      const result = manager.sendToCurrentAsync(args.command);
      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
        structuredContent: { result },
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `发送失败: ${e.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 8: get_last_output — 获取上次命令的输出
// ============================================================
server.registerTool(
  "get_last_output",
  {
    title: "获取上次输出",
    description: "获取当前选中终端上一次命令执行的输出。",
    inputSchema: {},
    outputSchema: { output: z.string() },
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const output = manager.getCurrentLastOutput();
      return {
        content: [{ type: "text", text: output }],
        structuredContent: { output },
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `获取输出失败: ${e.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 9: get_all_output — 获取所有输出
// ============================================================
server.registerTool(
  "get_all_output",
  {
    title: "获取所有输出",
    description: "获取当前选中终端自创建以来的所有输出。",
    inputSchema: {},
    outputSchema: { output: z.string() },
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const output = manager.getCurrentAllOutput();
      const maxLen = 50000;
      const display =
        output.length > maxLen
          ? output.slice(-maxLen) +
            `\n\n... (输出过长，已截断，总共 ${output.length} 字符)`
          : output;
      return {
        content: [{ type: "text", text: display }],
        structuredContent: { output: display },
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `获取输出失败: ${e.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 10: clear_output — 清空输出缓冲区
// ============================================================
server.registerTool(
  "clear_output",
  {
    title: "清空输出",
    description: "清空当前选中终端的输出缓冲区。",
    inputSchema: {},
    outputSchema: { success: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async () => {
    try {
      manager.clearCurrentOutput();
      return {
        content: [{ type: "text", text: "输出已清空" }],
        structuredContent: { success: true },
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `清空失败: ${e.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 11: send_key — 发送控制键
// ============================================================
server.registerTool(
  "send_key",
  {
    title: "发送控制键",
    description:
      "向当前终端发送控制键/组合键/文本。用于打断卡死命令（Ctrl+C）、退出交互程序、输入方向键等。不等待返回结果，立即响应。",
    inputSchema: {
      key: z
        .string()
        .describe(
          "按键名称。支持: ctrl+a~z, enter, tab, esc, backspace, space, up/down/left/right, home/end/pgup/pgdn/insert/delete, text:自定义文本"
        ),
    },
    outputSchema: { result: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async (args) => {
    try {
      const result = manager.sendKeyToCurrent(args.key);
      return {
        content: [{ type: "text", text: `已发送按键: "${args.key}"` }],
        structuredContent: { result },
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `发送失败: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 12: get_current_terminal — 获取当前终端名称
// ============================================================
server.registerTool(
  "get_current_terminal",
  {
    title: "获取当前终端",
    description: "获取当前选中终端的名称和基本信息。",
    inputSchema: {},
    outputSchema: {
      name: z.string().nullable(),
      info: z.any().nullable(),
    },
    annotations: { readOnlyHint: true },
  },
  async () => {
    const result = manager.getCurrentTerminal();
    if (!result.name) {
      return {
        content: [{ type: "text", text: "当前没有选中终端" }],
        structuredContent: result,
      };
    }
    const info = result.info;
    const text =
      `当前终端: "${result.name}"\n` +
      `Shell: ${info.shell}\n` +
      `PID: ${info.pid || "N/A"}\n` +
      `状态: ${info.isRunning ? "运行中" : "已停止"}\n` +
      `空闲超时: ${info.timeoutMs === -1 ? "永不超时" : info.timeoutMs + "ms"}\n` +
      `空闲时长: ${Math.round(info.idleTime / 1000)}s\n` +
      `运行时长: ${Math.round(info.uptime / 1000)}s`;
    return {
      content: [{ type: "text", text }],
      structuredContent: result,
    };
  }
);

// ============================================================
// 工具 13: rename_terminal — 重命名终端
// ============================================================
server.registerTool(
  "rename_terminal",
  {
    title: "重命名终端",
    description: "重命名一个终端。",
    inputSchema: {
      old_name: z.string().describe("当前终端名称"),
      new_name: z.string().describe("新终端名称"),
    },
    outputSchema: { success: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (args) => {
    try {
      manager.renameTerminal(args.old_name, args.new_name);
      return {
        content: [
          {
            type: "text",
            text: `终端已重命名: "${args.old_name}" -> "${args.new_name}"`,
          },
        ],
        structuredContent: { success: true },
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `重命名失败: ${e.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 14: get_terminal_info — 获取终端详细信息
// ============================================================
server.registerTool(
  "get_terminal_info",
  {
    title: "获取终端详情",
    description:
      "获取指定终端（或当前终端）的详细信息：运行时间、PID、shell类型、空闲时长、输出缓冲区大小等。",
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe("终端名称，不传则获取当前终端"),
    },
    outputSchema: {
      name: z.string(),
      shell: z.string(),
      cwd: z.string().nullable(),
      pid: z.number().nullable(),
      isRunning: z.boolean(),
      timeoutMs: z.number(),
      idleTime: z.number(),
      uptime: z.number(),
      createdAt: z.string(),
      outputLength: z.number(),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const info = manager.getInfo(args.name || null);
      const text =
        `终端: "${info.name}"\n` +
        `Shell: ${info.shell}\n` +
        `工作目录: ${info.cwd || "默认"}\n` +
        `PID: ${info.pid || "N/A"}\n` +
        `状态: ${info.isRunning ? "运行中" : "已停止"}\n` +
        `空闲超时: ${info.timeoutMs === -1 ? "永不超时" : info.timeoutMs + "ms"}\n` +
        `空闲时长: ${Math.round(info.idleTime / 1000)}s\n` +
        `运行时长: ${Math.round(info.uptime / 1000)}s\n` +
        `创建时间: ${info.createdAt}\n` +
        `输出缓冲条目: ${info.outputLength}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: info,
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `获取信息失败: ${e.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ============================================================
// 工具 15: diagnose — 环境诊断
// ============================================================
server.registerTool(
  "diagnose",
  {
    title: "环境诊断",
    description:
      "诊断 lg_termX 运行环境：检查 node-pty 版本、SSH 可用性、PATH 等。用于排查 SSH 连接问题。",
    inputSchema: {},
    outputSchema: {
      nodeVersion: z.string(),
      nodePtyVersion: z.string().nullable(),
      sshPath: z.string().nullable(),
      sshVersion: z.string().nullable(),
      path: z.string(),
      platform: z.string(),
      activeTerminals: z.number(),
    },
    annotations: { readOnlyHint: true },
  },
  async () => {
    const { execSync } = await import("child_process");

    let nodePtyVersion = null;
    try {
      const ptyPkg = await import("node-pty/package.json", {
        assert: { type: "json" },
      }).catch(() => null);
      nodePtyVersion = ptyPkg?.default?.version || ptyPkg?.version || null;
    } catch {
      // ignore
    }

    let sshPath = null;
    let sshVersion = null;
    try {
      const isWin = process.platform === "win32";
      const whereCmd = isWin ? "where ssh" : "which ssh";
      const sshShell = isWin ? "cmd.exe" : "/bin/sh";
      sshPath = execSync(whereCmd, { timeout: 3000 })
        .toString()
        .trim()
        .split("\n")[0] || null;
      sshVersion = execSync("ssh -V 2>&1", { timeout: 3000, shell: sshShell })
        .toString()
        .trim() || null;
    } catch {
      // ignore
    }

    const info = {
      nodeVersion: process.version,
      nodePtyVersion,
      sshPath,
      sshVersion,
      path: process.env.PATH || "",
      platform: `${process.platform} ${process.arch}`,
      activeTerminals: manager.terminals.size,
    };

    const text =
      `lg_termX 环境诊断:\n` +
      `Node.js: ${info.nodeVersion}\n` +
      `node-pty: ${info.nodePtyVersion || "未检测到"}\n` +
      `SSH 路径: ${info.sshPath || "未找到"}\n` +
      `SSH 版本: ${info.sshVersion || "未知"}\n` +
      `平台: ${info.platform}\n` +
      `活动终端数: ${info.activeTerminals}\n` +
      `PATH 条目数: ${info.path.split(";").length}`;

    return {
      content: [{ type: "text", text }],
      structuredContent: info,
    };
  }
);

// ============================================================
// 工具 16: kill_all_terminals — 终止所有终端
// ============================================================
server.registerTool(
  "kill_all_terminals",
  {
    title: "终止所有终端",
    description: "一键终止并删除所有终端。",
    inputSchema: {},
    outputSchema: { success: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async () => {
    try {
      const count = manager.terminals.size;
      await manager.killAllTerminals();
      return {
        content: [
          {
            type: "text",
            text: `已终止 ${count} 个终端`,
          },
        ],
        structuredContent: { success: true, killed: count },
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `终止失败: ${e.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ============================================================
// 启动服务器
// ============================================================

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("lg_termX MCP Server 已启动 (stdio)");
  console.error("提供 16 个工具: create_terminal, select_terminal, list_terminals, kill_terminal, set_timeout, send_command, send_command_async, get_last_output, get_all_output, clear_output, send_key, get_current_terminal, rename_terminal, get_terminal_info, diagnose, kill_all_terminals");
}

// 优雅退出
process.on("SIGINT", async () => {
  console.error("\n[lg_termX] 收到 SIGINT，正在清理...");
  await manager.destroy();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error("\n[lg_termX] 收到 SIGTERM，正在清理...");
  await manager.destroy();
  process.exit(0);
});

// 未捕获异常也尝试清理
process.on("uncaughtException", async (err) => {
  console.error(`[lg_termX] 未捕获异常: ${err.message}`);
  await manager.destroy();
  process.exit(1);
});

runServer().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});