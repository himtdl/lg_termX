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
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_SEPARATOR = "\n=====TERM_CMD_BOUNDARY=====\n";

/**
 * 获取格式化时间字符串（用于日志）
 * @param {Date} [date]
 * @returns {string} HH:mm:ss
 */
function fmtTime(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

/**
 * 安全解码 buffer：优先 UTF-8，含替换字符时回退 GBK
 * @param {Buffer|string} buf
 * @returns {string}
 */
function safeDecode(buf) {
  if (typeof buf === "string") return buf;
  const str = buf.toString("utf-8");
  if (str.indexOf("\ufffd") >= 0) {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return str;
    }
  }
  return str;
}

/**
 * 过滤 ANSI 终端控制序列（CSI / OSC / 其他转义码）
 * 这些序列是终端渲染指令（光标、清屏、标题、粘贴模式等），
 * 在纯文本日志中无意义且极度干扰阅读，默认过滤。
 * 如需保留原始字节流（调试 node-pty 输出），设置 log_raw = true。
 * @param {string} str
 * @returns {string}
 */
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")   // CSI: Esc[n;mH
    .replace(/\x1b\][^\x07]*\x07/g, "")         // OSC: Esc]0;...BEL
    .replace(/\x1b\][^\x1b]*\x1b\\/g, "")       // OSC: Esc]...ST
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "");  // 其他: SOS/PM/APC 等
}

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

    // —— 日志 ——
    this._logPath = null;
    /** @type {fs.WriteStream|null} */
    this._logStream = null;
    /** @type {boolean} 是否保留原始字节流（含ANSI控制序列），默认false即过滤 */
    this._logRaw = !!config.logRaw;
    this._initLog();
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
  //  日志系统
  // ════════════════════════════════════════════════

  /**
   * 初始化日志文件
   */
  _initLog() {
    try {
      const logDir = path.join(__dirname, "log");
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
      const safeName = this.name.replace(/[\\/:*?"<>|]/g, "_");
      this._logPath = path.join(logDir, `${safeName}_${ts}.log`);
      this._logStream = fs.createWriteStream(this._logPath, { flags: "a" });
      this._writeLog(`[lg_termX v1.0.5] 终端 "${this.name}" 日志开始 (引擎: ${this._engine})`);
    } catch (e) {
      console.error(`[lg_termX] 日志初始化失败: ${e.message}`);
    }
  }

  /**
   * 写入日志
   * @param {string} line
   */
  _writeLog(line) {
    if (!this._logStream) return;
    try {
      this._logStream.write(`[${fmtTime()}] ${line}\n`);
    } catch {
      // 日志写入失败不影响主流程
    }
  }

  /**
   * 关闭日志流
   */
  _closeLog() {
    if (this._logStream) {
      try {
        this._writeLog(`[关闭] 终端 "${this.name}" 日志结束`);
        this._logStream.end();
      } catch {}
      this._logStream = null;
    }
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
        let bootCmd = "";

        if (shell === "cmd.exe" || shell === "cmd") {
          ptyProcess = ptySpawn("cmd.exe", [], ptyOptions);
          bootCmd = "chcp 65001 > nul\r\n";
        } else if (shell === "powershell.exe" || shell === "powershell") {
          ptyProcess = ptySpawn("powershell.exe", ["-NoLogo", "-NoExit"], ptyOptions);
          bootCmd = "$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n";
        } else {
          ptyProcess = ptySpawn("cmd.exe", ["/k", shell], ptyOptions);
          bootCmd = "chcp 65001 > nul\r\n";
        }

        this._ptyProcess = ptyProcess;
        this.pid = ptyProcess.pid;
        this.isRunning = true;
        this.lastActivityTime = Date.now();
        this.outputBuffer = [];
        this.lastCommandOutput = "";

        ptyProcess.onData((data) => {
          const decoded = safeDecode(data);
          // 容量保护：限制 outputBuffer 最多 200 条目（防止 top 等无限输出撑爆内存）
          if (this.outputBuffer.length > 200) {
            this.outputBuffer.splice(0, 100);
          }
          this.outputBuffer.push(decoded);
          const clean = this._logRaw ? decoded : stripAnsi(decoded);
          this._writeLog(`<<< ${clean.trimEnd()}`);
          this.lastActivityTime = Date.now();
        });

        ptyProcess.onExit(({ exitCode, signal }) => {
          const reason = signal ? `信号: ${signal}` : `退出码: ${exitCode}`;
          this.outputBuffer.push(`\n[进程已退出，${reason}]\n`);
          this._writeLog(`[进程退出] ${reason}`);
          this.isRunning = false;
          this.pid = null;
          this._ptyProcess = null;
        });

        // 注入 UTF-8 编码切换命令
        if (bootCmd) {
          ptyProcess.write(bootCmd);
          this._writeLog(">>> [系统] 注入UTF-8编码切换");
        }

        setTimeout(() => resolve(), 1000);
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
              // 容量保护：_sshStdout 上限 100KB
              if (this._sshStdout.length > 100000) {
                this._sshStdout = this._sshStdout.slice(-50000);
              }
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

                  // 返回值截断
                  const truncated = this._truncateOutput(combined);
                  this.lastCommandOutput = truncated;

                  // resolve 用截断后的值
                  const resolveFn = this._sshPendingResolve;
                  this._sshPendingResolve = null;
                  this._sshPendingCommand = "";
                  resolveFn(truncated);

                  const clean = this._logRaw ? combined : stripAnsi(combined);
                  this._writeLog(`<<< ${clean.trimEnd()}`);

                  // 重置缓冲区
                  this._sshStdout = "";
                  this._sshStderr = "";
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
   * @param {number|null} timeoutMs - 超时毫秒，覆盖默认值
   * @returns {Promise<string>}
   */
  sendCommand(command, waitMs = 2000, timeoutMs = null) {
    this._writeLog(`>>> ${command}`);
    if (this._engine === "ssh2") {
      return this._sendSsh2(command, timeoutMs);
    }
    return this._sendPty(command, waitMs, timeoutMs);
  }

  /**
   * 异步发送命令：立即返回，不等待执行结果
   * 适用于 npm install、git clone、构建等长时间任务
   * @param {string} command
   * @returns {string}
   */
  sendCommandAsync(command) {
    this._writeLog(`>>> [异步] ${command}`);
    if (this._engine === "ssh2") {
      if (!this._sshShell || !this._sshShell.writable) {
        throw new Error(`终端 "${this.name}" 连接已断开`);
      }
      // SSH2 异步：只写命令+换行，不加 delimiter echo（不等待结果）
      this._sshShell.write(command + "\n");
    } else {
      if (!this._ptyProcess) {
        throw new Error(`终端 "${this.name}" 未运行`);
      }
      this._recordBoundary();
      this._ptyProcess.write(command + "\r\n");
    }
    this.lastActivityTime = Date.now();
    return "命令已发送（异步执行）。请使用 get_last_output/get_all_output 轮询结果";
  }

  /** 返回值截断上限（防止百万行输出撑爆 token） */
  _truncateOutput(output) {
    const limit = 5000;
    if (output.length > limit) {
      return output.slice(0, limit) + `\n\n... [输出过长已截断，共 ${output.length} 字符，完整内容见日志文件]`;
    }
    return output;
  }

  // —— PTY 发送 ——
  _sendPty(command, waitMs, timeoutMs) {
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
      const maxWaitMs = (timeoutMs && timeoutMs > 0) ? timeoutMs : 30000;
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
          const rawOutput = this.outputBuffer.slice(startIdx).join("");
          const newOutput = this._truncateOutput(rawOutput);
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
  _sendSsh2(command, timeoutMs) {
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

      // 超时保护（默认 60 秒，可通过 timeoutMs 覆盖）
      const ttl = (timeoutMs && timeoutMs > 0) ? timeoutMs : 60000;
      setTimeout(() => {
        if (this._sshPendingResolve) {
          // 超时前保存已接收的输出（不丢弃）
          const raw = this._sshStdout.trimEnd();
          if (raw) {
            const clean = this._logRaw ? raw : stripAnsi(raw);
            this.outputBuffer.push(raw + "\n");
            this.lastCommandOutput = this._truncateOutput(raw);
            this._writeLog(`<<< [超时截断] ${clean.trimEnd()}`);
          }
          this._sshStdout = "";
          this._sshStderr = "";
          this._sshPendingResolve = null;
          reject(new Error(`命令 "${command}" 执行超时（${ttl / 1000}秒），已保存中途输出`));
        }
      }, ttl);
    });
  }

  // ════════════════════════════════════════════════
  //  控制键发送
  // ════════════════════════════════════════════════

  /**
   * 向终端发送控制键/组合键/文本
   * @param {string} key - 键名，如 "ctrl+c" "enter" "up" "text:hello"
   */
  sendKey(key) {
    const bytes = this._resolveKey(key);
    if (bytes === null) {
      throw new Error(`不支持的按键: "${key}"。支持: ctrl+a~z, enter, tab, esc, backspace, space, up/down/left/right, home/end/pgup/pgdn/insert/delete, text:xxx`);
    }

    if (this._engine === "ssh2") {
      if (!this._sshShell || !this._sshShell.writable) {
        throw new Error(`终端 "${this.name}" 连接已断开`);
      }
      this._sshShell.write(bytes);
      this._writeLog(`>>> [按键] ${key}`);
    } else {
      if (!this._ptyProcess) {
        throw new Error(`终端 "${this.name}" 未运行`);
      }
      this._ptyProcess.write(bytes);
      this._writeLog(`>>> [按键] ${key}`);
    }
    this.lastActivityTime = Date.now();
    return "OK";
  }

  /**
   * 解析键名到字节
   * @param {string} key
   * @returns {string|null}
   */
  _resolveKey(key) {
    // 控制字符 ctrl+a ~ ctrl+z → \x01 ~ \x1a
    const ctrlMatch = key.match(/^ctrl\+([a-z])$/i);
    if (ctrlMatch) {
      const ch = ctrlMatch[1].toLowerCase();
      if (ch >= 'a' && ch <= 'z') {
        return String.fromCharCode(ch.charCodeAt(0) - 96);
      }
    }

    // 预定义按键
    const MAP = {
      enter: "\r",
      tab: "\t",
      esc: "\x1b",
      backspace: "\x7f",
      space: " ",
      up: "\x1b[A",
      down: "\x1b[B",
      left: "\x1b[D",
      right: "\x1b[C",
      home: "\x1b[H",
      end: "\x1b[F",
      pgup: "\x1b[5~",
      pgdn: "\x1b[6~",
      insert: "\x1b[2~",
      delete: "\x1b[3~",
    };
    if (MAP[key.toLowerCase()]) {
      return MAP[key.toLowerCase()];
    }

    // 自定义文本 text:xxx
    if (key.startsWith("text:")) {
      return key.slice(5);
    }

    return null;
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
      const done = () => {
        this._closeLog();
        resolve();
      };

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
        return done();
      }

      // PTY 清理
      if (!this._ptyProcess || !this.isRunning) {
        this.isRunning = false;
        this.pid = null;
        this._ptyProcess = null;
        return done();
      }

      if (this.pid) {
        try {
          const killer = nodeSpawn("taskkill", ["/PID", String(this.pid), "/T", "/F"]);
          killer.on("close", () => {
            this.isRunning = false;
            this.pid = null;
            this._ptyProcess = null;
            done();
          });
          setTimeout(() => {
            if (this.isRunning) {
              this.isRunning = false;
              this.pid = null;
              this._ptyProcess = null;
              done();
            }
          }, 3000);
        } catch {
          try { this._ptyProcess.kill(); } catch {}
          this.isRunning = false;
          this.pid = null;
          this._ptyProcess = null;
          done();
        }
      } else {
        this.isRunning = false;
        this._ptyProcess = null;
        done();
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
      logPath: this._logPath,
    };
  }
}