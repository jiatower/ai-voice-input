import { app } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  id: string;
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
};

const maxEntries = 600;

function logPath() {
  return join(app.getPath("userData"), "logs.jsonl");
}

function serializeData(data: unknown) {
  if (data === undefined) return undefined;
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack };
  }
  return data;
}

export function writeLog(level: LogLevel, scope: string, message: string, data?: unknown) {
  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    time: new Date().toISOString(),
    level,
    scope,
    message,
    data: serializeData(data)
  };

  const file = logPath();
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function readLogs(limit = maxEntries): LogEntry[] {
  const file = logPath();
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  return lines
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as LogEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is LogEntry => Boolean(entry))
    .reverse();
}

export function clearLogs() {
  const file = logPath();
  mkdirSync(dirname(file), { recursive: true });
  truncateSync(file, 0);
}

export function getLogPath() {
  return logPath();
}
