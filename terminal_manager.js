/**
 *
 *  Project: lg_termX
 *  Name: terminal_manager.js
 *  Type: Model - 终端管理器
 *  Description: 管理多个 TerminalSession，提供选择、列表、空闲超时扫描等功能
 *  Author: himtdl(老高)
 *  Date: 2026/6/1
 *  Powered by laogaohome.top
 *  Copyright © 2026 himtdl. All rights reserved.
 *
 *  老高之家 | 版权所有
 *
 */

import { TerminalSession } from "./terminal_session.js";

export class TerminalManager {
  constructor() {
    /** @type {Map<string, TerminalSession>} */
    this.terminals = new Map();
    /** @type {string|null} */
    this.currentName = null;
    this._sweepTimer = null;
    this._sweepIntervalMs = 30000; // 每30秒扫描一次超时
    this._startSweep();
  }

  /**
   * 启动空闲超时扫描定时器
   */
  _startSweep() {
    this._sweepTimer = setInterval(() => {
      this._sweepIdleTerminals();
    }, this._sweepIntervalMs);
  }

  /**
   * 扫描并关闭超时的终端
   */
  async _sweepIdleTerminals() {
    const toKill = [];
    for (const [name, session] of this.terminals) {
      if (session.isRunning && session.isIdleTimeout()) {
        toKill.push(name);
      }
    }
    for (const name of toKill) {
      try {
        await this.killTerminal(name);
        console.error(`[lg_termX] 终端 "${name}" 因空闲超时自动关闭`);
      } catch (e) {
        console.error(`[lg_termX] 关闭超时终端 "${name}" 失败: ${e.message}`);
      }
    }
  }

  /**
   * 创建新终端
   * @param {string} name - 终端名称
   * @param {object|string} configOrShell - 配置对象（SSH2模式）或 shell 字符串（PTY模式，兼容旧调用）
   * @param {string|null} [cwd] - 工作目录（仅PTY模式）
   * @returns {Promise<object>}
   */
  async createTerminal(name, configOrShell = "cmd.exe", cwd = null) {
    if (this.terminals.has(name)) {
      throw new Error(`终端 "${name}" 已存在`);
    }

    let config;
    if (typeof configOrShell === "object") {
      // SSH2 模式：config = { engine: "ssh2", host, port, username, password }
      config = configOrShell;
    } else {
      // PTY 模式（兼容旧调用）：configOrShell 是 shell 字符串
      config = {
        engine: "pty",
        shell: configOrShell,
        cwd,
      };
    }

    const session = new TerminalSession(name, config);
    await session.start();
    this.terminals.set(name, session);

    // 如果还没有当前终端，自动选中
    if (!this.currentName) {
      this.currentName = name;
    }

    return session.getInfo();
  }

  /**
   * 选择当前终端
   * @param {string} name
   * @returns {object}
   */
  selectTerminal(name) {
    if (!this.terminals.has(name)) {
      throw new Error(`终端 "${name}" 不存在`);
    }
    this.currentName = name;
    return this.getCurrentTerminal();
  }

  /**
   * 获取当前选中终端
   * @returns {object} { name, info }
   */
  getCurrentTerminal() {
    if (!this.currentName) {
      return { name: null, info: null };
    }
    const session = this.terminals.get(this.currentName);
    return {
      name: this.currentName,
      info: session ? session.getInfo() : null,
    };
  }

  /**
   * 获取当前终端 session（内部使用）
   * @returns {TerminalSession}
   */
  _getCurrentSession() {
    if (!this.currentName) {
      throw new Error("没有选中终端，请先 create 或 select");
    }
    const session = this.terminals.get(this.currentName);
    if (!session) {
      throw new Error(`当前终端 "${this.currentName}" 不存在`);
    }
    return session;
  }

  /**
   * 列出所有终端
   * @returns {Array<object>}
   */
  listTerminals() {
    const result = [];
    for (const [name, session] of this.terminals) {
      const info = session.getInfo();
      info.isCurrent = name === this.currentName;
      result.push(info);
    }
    return result;
  }

  /**
   * 终止指定终端
   * @param {string} name
   */
  async killTerminal(name) {
    if (!this.terminals.has(name)) {
      throw new Error(`终端 "${name}" 不存在`);
    }
    const session = this.terminals.get(name);
    await session.kill();
    this.terminals.delete(name);
    if (this.currentName === name) {
      // 尝试切换到其他终端
      const remaining = this.terminals.keys().next().value;
      this.currentName = remaining || null;
    }
  }

  /**
   * 终止所有终端
   */
  async killAllTerminals() {
    const names = [...this.terminals.keys()];
    for (const name of names) {
      try {
        await this.killTerminal(name);
      } catch (e) {
        console.error(`[lg_termX] 终止 "${name}" 失败: ${e.message}`);
      }
    }
    this.currentName = null;
  }

  /**
   * 重命名终端
   * @param {string} oldName
   * @param {string} newName
   */
  renameTerminal(oldName, newName) {
    if (!this.terminals.has(oldName)) {
      throw new Error(`终端 "${oldName}" 不存在`);
    }
    if (this.terminals.has(newName)) {
      throw new Error(`终端 "${newName}" 已存在`);
    }
    const session = this.terminals.get(oldName);
    session.name = newName;
    this.terminals.delete(oldName);
    this.terminals.set(newName, session);
    if (this.currentName === oldName) {
      this.currentName = newName;
    }
  }

  /**
   * 设置终端超时
   * @param {string} name
   * @param {number} timeoutMs - 超时毫秒，-1 永不超时
   */
  setTimeout(name, timeoutMs) {
    if (!this.terminals.has(name)) {
      throw new Error(`终端 "${name}" 不存在`);
    }
    this.terminals.get(name).setTimeout(timeoutMs);
  }

  /**
   * 向当前终端发送命令
   * @param {string} command
   * @param {number} waitMs
   * @returns {Promise<string>}
   */
  async sendToCurrent(command, waitMs = 2000) {
    const session = this._getCurrentSession();
    if (!session.isRunning) {
      throw new Error(`终端 "${session.name}" 已停止，请重新创建`);
    }
    return session.sendCommand(command, waitMs);
  }

  /**
   * 获取当前终端上次输出
   * @returns {string}
   */
  getCurrentLastOutput() {
    return this._getCurrentSession().getLastOutput();
  }

  /**
   * 获取当前终端所有输出
   * @returns {string}
   */
  getCurrentAllOutput() {
    return this._getCurrentSession().getAllOutput();
  }

  /**
   * 清空当前终端输出
   */
  clearCurrentOutput() {
    this._getCurrentSession().clearOutput();
  }

  /**
   * 获取终端信息
   * @param {string|null} name - 不传则获取当前终端
   */
  getInfo(name = null) {
    const targetName = name || this.currentName;
    if (!targetName || !this.terminals.has(targetName)) {
      throw new Error(`终端 "${targetName}" 不存在`);
    }
    return this.terminals.get(targetName).getInfo();
  }

  /**
   * 销毁管理器，清理所有资源
   */
  async destroy() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    await this.killAllTerminals();
  }
}