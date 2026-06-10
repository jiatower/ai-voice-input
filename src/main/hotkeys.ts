import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeLog } from "./logger";

type HotkeyName = "dictation" | "question";
type HotkeyCallbacks = {
  onDown: (name: HotkeyName) => void;
  onUp: (name: HotkeyName) => void;
};

type ParsedHotkey = {
  name: HotkeyName;
  keyCode: number;
  modifiers: number;
};

let watcher: ChildProcess | null = null;

const modifierBits: Record<string, number> = {
  command: 1,
  cmd: 1,
  meta: 1,
  control: 2,
  ctrl: 2,
  alt: 4,
  option: 4,
  shift: 8
};

const macKeyCodes: Record<string, number> = {
  A: 0,
  S: 1,
  D: 2,
  F: 3,
  H: 4,
  G: 5,
  Z: 6,
  X: 7,
  C: 8,
  V: 9,
  B: 11,
  Q: 12,
  W: 13,
  E: 14,
  R: 15,
  Y: 16,
  T: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "=": 24,
  "9": 25,
  "7": 26,
  "-": 27,
  "8": 28,
  "0": 29,
  "]": 30,
  O: 31,
  U: 32,
  "[": 33,
  I: 34,
  P: 35,
  L: 37,
  J: 38,
  "'": 39,
  K: 40,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  N: 45,
  M: 46,
  ".": 47,
  TAB: 48,
  SPACE: 49,
  ENTER: 36,
  RETURN: 36,
  ESCAPE: 53,
  BACKSPACE: 51,
  DELETE: 51,
  LEFT: 123,
  RIGHT: 124,
  DOWN: 125,
  UP: 126
};

function helperPath() {
  const relative = join("helpers", "HotkeyWatcher");
  return app.isPackaged ? join(process.resourcesPath, relative) : join(process.cwd(), "build", relative);
}

function parseAccelerator(name: HotkeyName, accelerator: string): ParsedHotkey | null {
  const parts = accelerator.split("+").map((part) => part.trim()).filter(Boolean);
  let modifiers = 0;
  let key = "";

  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (modifierBits[normalized]) {
      modifiers |= modifierBits[normalized];
    } else {
      key = part.toUpperCase().replace(/^PERIOD$/, ".").replace(/^COMMA$/, ",");
    }
  }

  if (!key || macKeyCodes[key] === undefined) return null;
  return { name, keyCode: macKeyCodes[key], modifiers };
}

export function stopHotkeyWatcher() {
  if (!watcher) return;
  watcher.kill();
  watcher = null;
}

export function startHotkeyWatcher(
  shortcuts: { dictation: string; question: string },
  callbacks: HotkeyCallbacks
) {
  stopHotkeyWatcher();

  if (process.platform !== "darwin") {
    return { dictation: false, question: false };
  }

  const executable = helperPath();
  const hotkeys = [
    parseAccelerator("dictation", shortcuts.dictation),
    parseAccelerator("question", shortcuts.question)
  ].filter((item): item is ParsedHotkey => Boolean(item));

  if (!existsSync(executable) || hotkeys.length === 0) {
    writeLog("warn", "hotkeys", "全局按住说话 helper 不可用", { executable, hotkeys: hotkeys.length });
    return { dictation: false, question: false };
  }

  const child = spawn(executable, [], {
    env: { ...process.env, AI_VOICE_HOTKEYS: JSON.stringify(hotkeys) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  watcher = child;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
      const [phase, name] = line.trim().split(/\s+/);
      if ((name === "dictation" || name === "question") && phase === "down") callbacks.onDown(name);
      if ((name === "dictation" || name === "question") && phase === "up") callbacks.onUp(name);
      if (phase === "ready") writeLog("info", "hotkeys", "按住说话监听已启动", { hotkeys });
    }
  });
  child.stderr?.on("data", (chunk: string) => writeLog("error", "hotkeys", "按住说话监听错误", { error: chunk.trim() }));
  child.on("exit", (code, signal) => {
    writeLog(code === 0 ? "info" : "warn", "hotkeys", "按住说话监听已退出", { code, signal });
    watcher = null;
  });

  return {
    dictation: Boolean(hotkeys.find((item) => item.name === "dictation")),
    question: Boolean(hotkeys.find((item) => item.name === "question"))
  };
}
