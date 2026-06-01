/**
 *
 *  Project: lg_termX
 *  Name: terminal_session.js
 *  Type: Model - 终端会话管理类（双引擎）
 *  Description: PTY 引擎（node-pty）用于本地 cmd/powershell；SSH2 引擎（ssh2 库）用于远程 SSH 连接
 *  Author: himtdl(老高)
 *  Date: 2026/6/1
 *  Powered by laogaohome.top
 *  Copyright © 2026 himtdl. All rights reserved.
 *
 *  老高之家 | 版权所有
 *
 */

import { spawn as nodeSpawn } from "child_process";
import { spawn as ptySpawn } from "node-pty";
import { Client } from "ssh2";

const OUTPUT_SEPARATOR = "\n=====TERM_CMD_BOUNDARY=====\n";

/**
 * 生成唯一的命令结束标记
 * @param {number} counter
 * @returns {string}
 */
function generateDelimiter(counter) {
  return `__MCP_SSH_EOF_${counter}_${Date.now()}__`;
}

export class TerminalSession {
  /**
   * @param {string} name - 终端名称
   * @param {object} config - 配置对象
   * @param {'pty'|'ssh2'} config.engine - 引擎类型
   *
   * PTY 配置：
   * @param {string} [config.shell="cmd.exe"] - shell 路径
   * @param {string} [config.cwd] - 工作目录
   *
   * SSH2 配置：
   * @param {string} [config.host] - 远程主机
   * @param {number} [config.port=22] - SSH 端口
   * @param {string} [config.username] - 用户名
   * @param {string} [config.password] - 密码
   *
   * @param {number} [timeoutMs=300000] - 空闲超时（毫秒），-1 表示永不超时
   */
  constructor(name, config = {}, timeoutMs = 300000) {
    this.name = name;
    this.config = config;
    this.timeoutMs = timeoutMs;

    /** @type {'pty'|'ssh2'} */
    this._engine = config.engine || "pty";

    // —— 通用属性 ——
    this.outputBuffer = [];
    this.lastCommandOutput = "";
    this.lastActivityTime = Date.now();
    this.isRunning = false;
    this.pid = null;
    this.createdAt = Date.now();

    // —— PTY 属性 ——
    /** @type {import('node-pty').IPty|null} */
    this._ptyProcess = null;

    // —— SSH2 属性 ——
    /** @type {Client|null} */
    this._sshClient = null;
    /** @type {import('ssh2').ClientChannel|null} */
    this._sshShell = null;
    this._sshStdout = "";
    this._sshStderr = "";
    this._sshDelimiterCounter = 0;
    /** @type {((output: string) => void)|null} */
    this._sshPendingResolve = null;
    this._sshPendingCommand = "";
    this._sshBooting = true;
    this._sshHistory = [];
  }

  /**
   * 启动终端进程
   */
  start() {
    if (this._engine === "ssh2") {
      return this._startSsh2();
    }
    return this._startPty();
  }

  // ════════════════════════════════════════════════
  //  PTY 引擎
  // ════════════════════════════════════════════════

  _startPty() {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        return reject(new Error(`终端 "${this.name}" 已经在运行中`));
      }

      const shell = this.config.shell || "cmd.exe";
      const ptyOptions = {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: this.config.cwd || process.cwd(),
        env: { ...process.env },
      };

      try {
        let ptyProcess;

        if (shell === "cmd.exe" || shell === "cmd") {
          ptyProcess = ptySpawn("cmd.exe", [], ptyOptions);
        } else if (shell === "powershell.exe" || shell === "powershell") {
          ptyProcess = ptySpawn("powershell.exe", ["-NoLogo", "-NoExit"], ptyOptions);
        } else {
          ptyProcess = ptySpawn("cmd.exe", ["/k", shell], ptyOptions);
        }

        this._ptyProcess = ptyProcess;
        this.pid = ptyProcess.pid;
        this.isRunning = true;
        this.lastActivityTime = Date.now();
        this.outputBuffer = [];
        this.lastCommandOutput = "";

        ptyProcess.onData((data) => {
          this.outputBuffer.push(data);
          this.lastActivityTime = Date.now();
        });

        ptyProcess.onExit(({ exitCode, signal }) => {
          const reason = signal ? `信号: ${signal}` : `退出码: ${exitCode}`;
          this.outputBuffer.push(`\n[进程已退出，${reason}]\n`);
          this.isRunning = false;
          this.pid = null;
          this._ptyProcess = null;
        });

        setTimeout(() => resolve(), 500);
      } catch (err) {
        reject(err);
      }
    });
  }

  // ════════════════════════════════════════════════
  //  SSH2 引擎
  // ════════════════════════════════════════════════

  _startSsh2() {
    return new Promise((resolve, reject) => {
      const { host, port = 22, username, password } = this.config;

      const client = new Client();
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error("SSH 连接超时（15秒）"));
      }, 15000);

      client.on("ready", () => {
        clearTimeout(timeout);

        client.shell(
          { term: "xterm-256color", rows: 40, cols: 200 },
          (err, stream) => {
            if (err) {
              client.end();
              reject(new Error(`打开 shell 失败: ${err.message}`));
              return;
            }

            this._sshClient = client;
            this._sshShell = stream;
            this.isRunning = true;
            this.lastActivityTime = Date.now();
            this.outputBuffer = [];
            this.lastCommandOutput = "";
            this._sshStdout = "";
            this._sshStderr = "";
            this._sshDelimiterCounter = 0;
            this._sshPendingResolve = null;
            this._sshPendingCommand = "";
            this._sshBooting = true;
            this._sshHistory = [];

            // 初始化 shell 环境
            stream.write("export PS1=''\nexport LANG=en_US.UTF-8\nstty -echo 2>/dev/null\n");

            let bootCheckCount = 0;

            stream.on("data", (data) => {
              const text = typeof data === "string" ? data : data.toString("utf-8");

              if (this._sshBooting) {
                bootCheckCount++;
                if (bootCheckCount >= 3) {
                  this._sshBooting = false;
                  this._sshStdout = "";
                  this._sshStderr = "";
                }
                return;
              }

              this._sshStdout += text;
              this.lastActivityTime = Date.now();

              // 检查 delimiter
              if (this._sshPendingResolve) {
                const delimPattern = /__MCP_SSH_EOF_\d+_\d+__/;
                const match = this._sshStdout.match(delimPattern);
                if (match) {
                  const delimIdx = this._sshStdout.indexOf(match[0]);
                  let output = this._sshStdout.substring(0, delimIdx).trimEnd();

                  // 清理命令回显
                  if (this._sshPendingCommand) {
                    const cmdLines = this._sshPendingCommand.split("\n");
                    for (const cmdLine of cmdLines) {
                      if (cmdLine.trim() && output.startsWith(cmdLine.trim())) {
                        output = output.substring(cmdLine.trim().length).trimStart();
                        output = output.replace(/^[\r\n]+/, "");
                        break;
                      }
                    }
                  }

                  const stderrOutput = this._sshStderr.trim();
                  let combined = output;
                  if (stderrOutput) {
                    combined = output + (output ? "\n" : "") + stderrOutput;
                  }

                  // 记录到 outputBuffer（兼容 get_all_output）
                  this.outputBuffer.push(combined + "\n");

                  this._sshHistory.push({
                    command: this._sshPendingCommand,
                    output: combined,
                    timestamp: Date.now(),
                  });

                  this.lastCommandOutput = combined;

                  // 重置缓冲区
                  this._sshStdout = "";
                  this._sshStderr = "";

                  const resolveFn = this._sshPendingResolve;
                  this._sshPendingResolve = null;
                  this._sshPendingCommand = "";
                  resolveFn(combined);
                }
              }
            });

            stream.stderr.on("data", (data) => {
              this._sshStderr += typeof data === "string" ? data : data.toString("utf-8");
            });

            stream.on("close", () => {
              this.isRunning = false;
              this.outputBuffer.push("\n[SSH 连接已关闭]\n");
              if (this._sshPendingResolve) {
                this._sshPendingResolve("连接已关闭\n" + this._sshStdout);
                this._sshPendingResolve = null;
              }
            });

            stream.on("error", (err) => {
              if (this._sshPendingResolve) {
                this._sshPendingResolve(`Shell 错误: ${err.message}\n${this._sshStdout}`);
                this._sshPendingResolve = null;
              }
            });

            // 等待 shell 初始化完成
            setTimeout(() => {
              this._sshBooting = false;
              this._sshStdout = "";
              this._sshStderr = "";
              resolve();
            }, 1500);
          }
        );
      });

      client.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`SSH 连接错误: ${err.message}`));
      });

      client.connect({
        host,
        port,
        username,
        password,
        readyTimeout: 10000,
        keepaliveInterval: 30000,
      });
    });
  }

  // ════════════════════════════════════════════════
  //  发送命令（根据引擎分发）
  // ════════════════════════════════════════════════

  /**
   * 发送命令到终端
   * @param {string} command
   * @param {number} waitMs - （PTY 模式）最小等待时间
   * @returns {Promise<string>}
   */
  sendCommand(command, waitMs = 2000) {
    if (this._engine === "ssh2") {
      return this._sendSsh2(command);
    }
    return this._sendPty(command, waitMs);
  }

  // —— PTY 发送 ——
  _sendPty(command, waitMs) {
    return new Promise((resolve, reject) => {
      if (!this.isRunning || !this._ptyProcess) {
        return reject(new Error(`终端 "${this.name}" 未运行`));
      }

      this._recordBoundary();
      const startIdx = this.outputBuffer.length;

      try {
        this._ptyProcess.write(command + "\r\n");
        this.lastActivityTime = Date.now();
      } catch (err) {
        return reject(new Error(`无法向终端写入命令: ${err.message}`));
      }

      const minWaitMs = Math.max(waitMs, 500);
      const maxWaitMs = 30000;
      const pollIntervalMs = 300;
      const stableThresholdMs = 2000;

      let lastOutputLen = 0;
      let stableTime = 0;
      let elapsed = 0;

      const poll = () => {
        const currentLen = this.outputBuffer.slice(startIdx).join("").length;
        if (currentLen !== lastOutputLen) {
          lastOutputLen = currentLen;
          stableTime = 0;
        } else {
          stableTime += pollIntervalMs;
        }
        elapsed += pollIntervalMs;
        const isStable = elapsed >= minWaitMs && stableTime >= stableThresholdMs;
        const isTimeout = elapsed >= maxWaitMs;
        if (isStable || isTimeout) {
          const newOutput = this.outputBuffer.slice(startIdx).join("");
          this.lastCommandOutput = newOutput;
          this.lastActivityTime = Date.now();
          resolve(newOutput || "(无输出)");
        } else {
          setTimeout(poll, pollIntervalMs);
        }
      };
      setTimeout(poll, minWaitMs);
    });
  }

  // —— SSH2 发送（delimiter + echo，参考 ssh-terminal 设计） ——
  _sendSsh2(command) {
    return new Promise((resolve, reject) => {
      if (!this.isRunning || !this._sshShell || !this._sshShell.writable) {
        return reject(new Error(`终端 "${this.name}" 连接已断开`));
      }

      this._recordBoundary();

      const delimiter = generateDelimiter(this._sshDelimiterCounter++);
      const fullCommand = `${command}\necho "${delimiter}"\n`;

      this._sshPendingResolve = resolve;
      this._sshPendingCommand = command;
      this._sshStdout = "";
      this._sshStderr = "";
      this.lastActivityTime = Date.now();

      try {
        this._sshShell.write(fullCommand);
      } catch (e) {
        this._sshPendingResolve = null;
        reject(new Error(`写入命令失败: ${e.message}`));
        return;
      }

      // 超时保护：60秒
      setTimeout(() => {
        if (this._sshPendingResolve) {
          this._sshPendingResolve = null;
          reject(new Error(`命令 "${command}" 执行超时（60秒）`));
        }
      }, 60000);
    });
  }

  // ════════════════════════════════════════════════
  //  输出方法
  // ════════════════════════════════════════════════

  _recordBoundary() {
    this.outputBuffer.push(OUTPUT_SEPARATOR);
  }

  getLastOutput() {
    return this.lastCommandOutput || "(尚未执行过命令)";
  }

  getAllOutput() {
    return this.outputBuffer.join("") || "(无输出)";
  }

  clearOutput() {
    this.outputBuffer = [];
    this.lastCommandOutput = "";
    this._sshStdout = "";
    this._sshStderr = "";
    this._sshHistory = [];
  }

  // ════════════════════════════════════════════════
  //  生命周期
  // ════════════════════════════════════════════════

  setTimeout(ms) {
    this.timeoutMs = ms;
  }

  isIdleTimeout() {
    if (this.timeoutMs === -1) return false;
    // SSH2 模式下如果正在等待命令返回，不算空闲
    if (this._engine === "ssh2" && this._sshPendingResolve) return false;
    return Date.now() - this.lastActivityTime > this.timeoutMs;
  }

  getIdleTime() {
    return Date.now() - this.lastActivityTime;
  }

  getUptime() {
    return Date.now() - this.createdAt;
  }

  kill() {
    return new Promise((resolve) => {
      if (this._engine === "ssh2") {
        // SSH2 清理
        try {
          if (this._sshShell) this._sshShell.close();
        } catch {}
        try {
          if (this._sshClient) this._sshClient.end();
        } catch {}
        if (this._sshPendingResolve) {
          this._sshPendingResolve("连接已关闭");
          this._sshPendingResolve = null;
        }
        this.isRunning = false;
        this.pid = null;
        this._sshClient = null;
        this._sshShell = null;
        return resolve();
      }

      // PTY 清理
      if (!this._ptyProcess || !this.isRunning) {
        this.isRunning = false;
        this.pid = null;
        this._ptyProcess = null;
        return resolve();
      }

      if (this.pid) {
        try {
          const killer = nodeSpawn("taskkill", ["/PID", String(this.pid), "/T", "/F"]);
          killer.on("close", () => {
            this.isRunning = false;
            this.pid = null;
            this._ptyProcess = null;
            resolve();
          });
          setTimeout(() => {
            if (this.isRunning) {
              this.isRunning = false;
              this.pid = null;
              this._ptyProcess = null;
              resolve();
            }
          }, 3000);
        } catch {
          try { this._ptyProcess.kill(); } catch {}
          this.isRunning = false;
          this.pid = null;
          this._ptyProcess = null;
          resolve();
        }
      } else {
        this.isRunning = false;
        this._ptyProcess = null;
        resolve();
      }
    });
  }

  getInfo() {
    return {
      name: this.name,
      engine: this._engine,
      shell: this.config.shell || `ssh://${this.config.username || ""}@${this.config.host || ""}:${this.config.port || 22}`,
      cwd: this.config.cwd || null,
      pid: this.pid,
      isRunning: this.isRunning,
      timeoutMs: this.timeoutMs,
      idleTime: this.getIdleTime(),
      uptime: this.getUptime(),
      createdAt: new Date(this.createdAt).toISOString(),
      outputLength: this.outputBuffer.length,
    };
  }
}