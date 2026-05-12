/**
 * Structured audit logger.
 *
 * Writes one JSON object per line to logs/audit-YYYY-MM-DD.log.
 * Also prints human-readable output to stdout/stderr.
 * The log file is never truncated — new entries are always appended.
 */

import * as fs from "fs";
import * as path from "path";
import { AuditEntry, LogLevel } from "./types";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m",  // cyan
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
};

const RESET = "\x1b[0m";

export class Logger {
  private readonly logDir: string;
  private readonly minLevel: LogLevel;
  private currentLogPath: string | null = null;

  constructor(logDir: string, minLevel: LogLevel = "info") {
    this.logDir = logDir;
    this.minLevel = minLevel;
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private getLogPath(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const newPath = path.join(this.logDir, `audit-${date}.log`);
    if (newPath !== this.currentLogPath) {
      this.currentLogPath = newPath;
    }
    return this.currentLogPath;
  }

  private write(entry: AuditEntry): void {
    if (LEVEL_RANK[entry.level] < LEVEL_RANK[this.minLevel]) return;

    // Append JSON line to audit file
    try {
      fs.appendFileSync(this.getLogPath(), JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Never crash the main process due to logging failure
    }

    // Human-readable stdout/stderr output
    const prefix = `${LEVEL_COLOR[entry.level]}[${entry.level.toUpperCase()}]${RESET}`;
    const msg = `${prefix} [${entry.module}] ${entry.action}`;
    const dataStr =
      Object.keys(entry.data).length > 0
        ? " " + JSON.stringify(entry.data)
        : "";

    if (entry.level === "error") {
      process.stderr.write(msg + dataStr + "\n");
    } else {
      process.stdout.write(msg + dataStr + "\n");
    }
  }

  log(
    level: LogLevel,
    module: string,
    action: string,
    data: Record<string, unknown> = {}
  ): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      action,
      data,
    };
    this.write(entry);
  }

  debug(module: string, action: string, data?: Record<string, unknown>): void {
    this.log("debug", module, action, data);
  }

  info(module: string, action: string, data?: Record<string, unknown>): void {
    this.log("info", module, action, data);
  }

  warn(module: string, action: string, data?: Record<string, unknown>): void {
    this.log("warn", module, action, data);
  }

  error(module: string, action: string, data?: Record<string, unknown>): void {
    this.log("error", module, action, data);
  }
}
