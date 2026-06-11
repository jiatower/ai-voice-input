import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  session,
  screen,
  Tray
} from "electron";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, saveConfig } from "./config";
import {
  AppConfig,
  appStyleMap,
  AppStatus,
  defaultConfig,
  defaultPrompts,
  modelPresets,
  POLISH_GUARD_DISPLAY,
  VocabularyEntry
} from "./defaults";
import {
  startHotkeyWatcher,
  stopHotkeyWatcher
} from "./hotkeys";
import { clearLogs, getLogPath, readLogs, writeLog } from "./logger";
import {
  getClipboardHistory,
  onClipboardHistoryChange,
  restoreClipboardEntry,
  startClipboardHistoryWatcher,
  stopClipboardHistoryWatcher,
  type ClipboardEntry
} from "./clipboardHistory";
import {
  callChatModel,
  cleanupRecordings,
  deliverText,
  FriendlyError,
  getPermissions,
  openPermissionSettings,
  requestMicrophone,
  transcribeAudio,
  wrapPolishContent
} from "./services";

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let recorderWindow: BrowserWindow | null = null;
let qaWindow: BrowserWindow | null = null;
let qaWindowAnswer = "";
let reviewWindow: BrowserWindow | null = null;
let reviewRawText = "";
type ReviewResolution = { action: "confirm" | "skip"; text: string };
let reviewResolve: ((value: ReviewResolution) => void) | null = null;
let tray: Tray | null = null;
let config: AppConfig = loadConfig();
let status: AppStatus = "idle";
let activeMode: "dictation" | "question" | null = null;
let recordingStartedAt = 0;
let recordingFrontApp = "";
let recoveryTimer: NodeJS.Timeout | null = null;
let isQuitting = false;
let recorderReady = false;
let stopRequestedWhileStarting = false;
let recordingStartSent = false;
const pendingRecorderMessages: Array<{ channel: string; payload?: unknown }> = [];
// globalShortcut 在 macOS 上有时会在一次按键里触发两次 down 事件（相隔 1-3ms），
// 用来去抖：相同 mode 在 DEBOUNCE_MS 内重复触发，直接忽略。
const DEBOUNCE_MS = 80;
let lastDownAt = 0;
let lastDownMode: "dictation" | "question" | null = null;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

function rendererUrl() {
  return process.env.VITE_DEV_SERVER_URL ?? `file://${join(__dirname, "../renderer/index.html")}`;
}

function assetPath(name: string) {
  return app.isPackaged ? join(process.resourcesPath, "build", name) : join(process.cwd(), "build", name);
}

function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function setStatus(next: AppStatus, detail = "") {
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  status = next;
  writeLog(next === "needs_attention" ? "warn" : "info", "status", next, { detail });
  broadcast("state:changed", { status, detail });
  updateOverlay(next, compactStatusDetail(next, detail));
}

function flashError(detail: string, timeoutMs = 3200) {
  activeMode = null;
  writeLog("error", "runtime", detail);
  setStatus("needs_attention", detail);
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    setStatus("idle", "后台待命");
  }, timeoutMs);
}

function compactStatusDetail(next: AppStatus, detail: string) {
  if (next !== "needs_attention") return detail;
  if (/录音时间太短|过短|too short/i.test(detail)) return "录音太短，请按住说完再松开";
  if (/没有录到声音|没有识别到清晰语音|未识别到文字|没有返回文字|no speech|blank audio/i.test(detail)) {
    return "未识别到语音，请再说一遍";
  }
  if (/麦克风|microphone/i.test(detail)) return "需要麦克风权限或输入设备";
  if (/网络|network|fetch|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(detail)) return "模型网络请求失败";
  if (/尚未配置大模型|模型返回为空|模型调用失败/i.test(detail)) return "模型配置或调用失败";
  if (/已有任务正在处理/i.test(detail)) return "正在处理上一段语音";
  if (/Whisper/i.test(detail)) return "本地语音识别失败";
  const normalized = detail.replace(/\s+/g, " ").trim();
  return normalized.length > 22 ? `${normalized.slice(0, 22)}...` : normalized;
}

function setupMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "notifications");
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === "media" || permission === "notifications";
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 820,
    minWidth: 1160,
    minHeight: 820,
    maxWidth: 1160,
    maxHeight: 820,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "AI Voice Input",
    backgroundColor: "#f7f8fb",
    icon: assetPath("icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(rendererUrl());
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 420,
    height: 84,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><style>
body{margin:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18202f}
.pill{height:72px;margin:6px 10px;border-radius:22px;background:rgba(250,252,255,.94);box-shadow:0 18px 45px rgba(20,35,60,.22);display:flex;align-items:center;gap:12px;padding:0 18px;box-sizing:border-box;border:1px solid rgba(120,135,160,.2)}
.dot{width:13px;height:13px;border-radius:50%;background:#3b82f6;box-shadow:0 0 0 0 rgba(59,130,246,.45)}
.recording .dot{background:#ef4444;animation:pulse 1s infinite}
.title{font-size:14px;font-weight:700}.detail{font-size:12px;color:#667085;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.35;max-width:320px}
@keyframes pulse{70%{box-shadow:0 0 0 12px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
</style></head><body><div id="pill" class="pill"><div class="dot"></div><div><div id="title" class="title">空闲</div><div id="detail" class="detail">后台待命</div></div></div>
<script>
const { ipcRenderer } = require("electron");
const names={idle:"空闲",recording:"正在录音",transcribing:"正在转写",thinking:"正在思考",generating:"正在生成",answering:"正在回复",needs_attention:"需要处理"};
ipcRenderer.on("overlay:update",(_,data)=>{document.getElementById("title").textContent=names[data.status]||data.status;document.getElementById("detail").textContent=data.detail||"";document.getElementById("pill").className="pill "+data.status;});
</script></body></html>`)}`
  );
}

function updateOverlay(next: AppStatus, detail: string) {
  if (!overlayWindow) return;
  overlayWindow.webContents.send("overlay:update", { status: next, detail });
  if (next === "idle") {
    setTimeout(() => overlayWindow?.hide(), 900);
    return;
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = display.workArea;
  overlayWindow.setPosition(Math.round(bounds.x + bounds.width / 2 - 210), Math.round(bounds.y + bounds.height - 108));
  overlayWindow.showInactive();
}

function estimateQaWindowSize(_question: string, answer: string) {
  const lines = answer.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 62)), 0);
  const height = Math.min(700, Math.max(200, 54 + lines * 20));
  const width = Math.min(760, Math.max(520, 520 + Math.min(200, Math.ceil(Math.sqrt(answer.length)) * 10)));
  return { width, height };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showReviewWindow(text: string, rawText: string, audioPath?: string, styleId?: string): Promise<ReviewResolution> {
  writeLog("info", "review", "准备弹出校对窗", { textLen: text.length, hasAudio: !!audioPath });
  reviewRawText = rawText;
  const currentStyleId = styleId || config.activePromptProfileId;
  const prevResolve = reviewResolve;
  reviewResolve = null;
  if (reviewWindow) {
    if (reviewWindow.isDestroyed()) {
      writeLog("warn", "review", "旧校对窗已销毁，直接置空");
      reviewWindow = null;
    } else {
      writeLog("info", "review", "关闭旧校对窗");
      reviewWindow.close();
      reviewWindow = null;
    }
  }
  if (prevResolve) prevResolve({ action: "skip", text: "" });

  return new Promise((resolve) => {
    reviewResolve = resolve;

    const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 50)), 0);
    const width = 560;
    const height = Math.min(460, Math.max(200, 60 + lines * 22));

    const win = new BrowserWindow({
      width,
      height,
      minWidth: 400,
      minHeight: 180,
      maxWidth: 700,
      maxHeight: 500,
      frame: false,
      transparent: true,
      resizable: true,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: "#00000000",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    reviewWindow = win;

    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = display.workArea;
    win.setPosition(
      Math.round(bounds.x + bounds.width / 2 - width / 2),
      Math.round(bounds.y + bounds.height / 2 - height / 2)
    );
    win.on("closed", () => {
      writeLog("info", "review", "校对窗 closed 事件");
      if (reviewResolve) {
        reviewResolve({ action: "skip", text });
        reviewResolve = null;
      }
      if (reviewWindow === win) reviewWindow = null;
    });

    win.webContents.on("did-finish-load", () => {
      writeLog("info", "review", "校对窗页面加载完成");
    });
    win.webContents.on("did-fail-load", (_event, code, desc) => {
      writeLog("warn", "review", "校对窗页面加载失败", { code, desc });
      if (reviewResolve) {
        reviewResolve({ action: "skip", text });
        reviewResolve = null;
      }
      if (reviewWindow === win) reviewWindow = null;
      try { win.close(); } catch { /* ignore */ }
    });

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
<head>
<meta charset="UTF-8" />
<style>
body{margin:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18202f}
.panel{height:100vh;display:flex;flex-direction:column;border-radius:12px;background:rgba(250,252,255,.98);border:1px solid rgba(120,135,160,.25);box-shadow:0 18px 50px rgba(20,35,60,.25);box-sizing:border-box}
.bar{-webkit-app-region:drag;display:flex;align-items:center;justify-content:space-between;padding:5px 10px;border-bottom:1px solid #edf0f5;flex-shrink:0}
.title{font-size:12px;font-weight:800;color:#475467}
.hint{font-size:10.5px;color:#98a2b3}
.actions{-webkit-app-region:no-drag;display:flex;gap:5px}
.btn{padding:4px 12px;border:0;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer}
.btn-confirm{background:#2563eb;color:#fff}.btn-confirm:hover{background:#1d4ed8}
.btn-skip{background:#eef2f7;color:#475467}.btn-skip:hover{background:#dbeafe}
.btn-play{background:#eef2f7;color:#475467;width:26px;min-width:26px;padding:0}.btn-play:hover{background:#fef3c7;color:#92400e}
.styleSelect{-webkit-app-region:no-drag;height:26px;border:1px solid #d0d5dd;border-radius:5px;background:#fff;color:#475467;font-size:11px;padding:0 4px;outline:none;cursor:pointer;max-width:100px}
.styleSelect:focus{border-color:#2563eb}
.body{flex:1;padding:8px 10px;display:flex;flex-direction:column;min-height:0}
textarea{flex:1;border:1px solid #d0d5dd;border-radius:8px;padding:10px;font-size:14px;font-family:inherit;resize:none;outline:none;line-height:1.55;color:#18202f;min-height:0;box-sizing:border-box}
textarea:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:#c7d0df;border:2px solid transparent;background-clip:padding-box;border-radius:999px}
</style>
</head>
<body>
<div class="panel">
  <div class="bar">
    <div><span class="title">校对文本</span><span class="hint"> \u00b7 Enter \u786e\u8ba4 \u00b7 Esc \u8df3\u8fc7</span></div>
    <div class="actions">
      <select id="styleSelect" class="styleSelect" title="切换润色风格">
        ${config.promptProfiles.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === currentStyleId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
      </select>
      ${audioPath ? `<button class="btn btn-play" id="play" data-audio="${escapeHtml(audioPath)}" title="播放录音">\u25b6</button>` : ""}
      <button class="btn btn-skip" id="skip">\u8df3\u8fc7</button>
      <button class="btn btn-confirm" id="confirm">\u786e\u8ba4</button>
    </div>
  </div>
  <div class="body"><textarea id="editor" autofocus>${escapeHtml(text)}</textarea></div>
</div>
<script>
const { ipcRenderer } = require("electron");
const editor = document.getElementById("editor");
editor.focus();
editor.setSelectionRange(editor.value.length, editor.value.length);
document.getElementById("confirm").addEventListener("click", () => ipcRenderer.send("review-window:confirm", editor.value));
document.getElementById("skip").addEventListener("click", () => ipcRenderer.send("review-window:skip"));
ipcRenderer.on("review:update-text", (_event, text) => {
  editor.value = text;
});
document.getElementById("styleSelect").addEventListener("change", function () {
  ipcRenderer.send("review-window:restyle", this.value);
});
editor.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Escape") { e.preventDefault(); ipcRenderer.send("review-window:skip"); }
});
document.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ipcRenderer.send("review-window:confirm", editor.value); }
  if (e.key === "Escape") { e.preventDefault(); ipcRenderer.send("review-window:skip"); }
});
${audioPath ? `
(function () {
  var playBtn = document.getElementById("play");
  var audioPath = playBtn.getAttribute("data-audio");
  var audioEl = null;
  var playing = false;
  function stop() {
    if (audioEl) { audioEl.pause(); audioEl = null; }
    playing = false;
    playBtn.textContent = "\u25b6";
  }
  playBtn.addEventListener("click", function () {
    if (playing) { stop(); return; }
    var { readFileSync } = require("fs");
    try {
      var buf = readFileSync(audioPath);
      var blob = new Blob([buf], { type: "audio/wav" });
      var url = URL.createObjectURL(blob);
      audioEl = new Audio(url);
      playing = true;
      playBtn.textContent = "\u23f9";
      audioEl.play();
      audioEl.addEventListener("ended", function () { URL.revokeObjectURL(url); stop(); });
      audioEl.addEventListener("error", function () { URL.revokeObjectURL(url); stop(); });
    } catch(e) { stop(); }
  });
})();
` : ""}
requestAnimationFrame(() => {
  const bar = document.querySelector(".bar");
  const textarea = document.querySelector("textarea");
  const desiredHeight = Math.min(460, Math.max(180, Math.ceil(bar.offsetHeight + textarea.scrollHeight + 16)));
  ipcRenderer.send("review-window:resize", { height: desiredHeight });
});
</script>
</body>
</html>`)}`);
    win.once("ready-to-show", () => win.show());
  });
}

function showQaWindow(question: string, answer: string) {
  qaWindow?.close();
  qaWindowAnswer = answer;
  const { width, height } = estimateQaWindowSize(question, answer);
  qaWindow = new BrowserWindow({
    width,
    height,
    minWidth: 480,
    minHeight: 180,
    maxWidth: 820,
    maxHeight: 700,
    frame: false,
    transparent: true,
    resizable: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  qaWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  positionQaWindow(width, height);
  qaWindow.on("closed", () => {
    qaWindow = null;
  });
  qaWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
<head>
<meta charset="UTF-8" />
<style>
body{margin:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18202f}
.panel{height:100vh;display:flex;flex-direction:column;overflow:hidden;border-radius:14px;background:rgba(250,252,255,.98);border:1px solid rgba(120,135,160,.25);box-shadow:0 22px 60px rgba(20,35,60,.28);box-sizing:border-box}
.bar{-webkit-app-region:drag;display:flex;align-items:center;gap:5px;padding:5px 10px;border-bottom:1px solid #edf0f5;min-height:0;flex-shrink:0}
.barLeft{display:flex;align-items:center;gap:5px;flex:1;min-width:0;overflow:hidden}
.badge{flex-shrink:0;font-size:10px;font-weight:800;color:#667085;background:#eef2f7;padding:2px 6px;border-radius:4px}
.qText{font-size:12px;color:#475467;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.actions{-webkit-app-region:no-drag;display:flex;gap:4px;flex-shrink:0}
button{width:26px;height:26px;border:0;border-radius:6px;background:#eef2f7;color:#263449;cursor:pointer;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;padding:0}
button:hover{background:#dbeafe;color:#1d4ed8}.close:hover{background:#fee4e2;color:#b42318}
button.copied{width:52px;background:#dcfce7;color:#15803d;font-size:11px;font-weight:800}
.body{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
.answerBody{flex:1;white-space:pre-wrap;font-size:14px;color:#18202f;line-height:1.55;overflow-y:auto;padding:8px 12px;word-break:break-word;min-height:0}
.answerBody::-webkit-scrollbar{width:8px}
.answerBody::-webkit-scrollbar-thumb{background:#c7d0df;border:2px solid transparent;background-clip:padding-box;border-radius:999px}
.answerBody::-webkit-scrollbar-track{background:transparent}
</style>
</head>
<body>
<div class="panel">
  <div class="bar">
    <div class="barLeft">
      <span class="badge">语音问答</span>
      <span class="qText" title="${escapeHtml(question)}">${escapeHtml(question)}</span>
    </div>
    <div class="actions">
      <button id="copy" title="复制回答">⧉</button>
      <button id="close" class="close" title="关闭">×</button>
    </div>
  </div>
  <div class="body">
    <div class="answerBody">${escapeHtml(answer)}</div>
  </div>
</div>
<script>
const { ipcRenderer } = require("electron");
const copyButton = document.getElementById("copy");
let copyTimer = null;
copyButton.addEventListener("click", () => {
  ipcRenderer.send("qa-window:copy");
  copyButton.classList.add("copied");
  copyButton.textContent = "已复制";
  copyButton.title = "已复制";
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copyButton.classList.remove("copied");
    copyButton.textContent = "⧉";
    copyButton.title = "复制回答";
  }, 1200);
});
document.getElementById("close").addEventListener("click", () => ipcRenderer.send("qa-window:close"));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") ipcRenderer.send("qa-window:close"); });
requestAnimationFrame(() => {
  const answerBody = document.querySelector(".answerBody");
  const bar = document.querySelector(".bar");
  const desiredHeight = Math.min(700, Math.max(180, Math.ceil(bar.offsetHeight + answerBody.scrollHeight + 8)));
  ipcRenderer.send("qa-window:resize", { height: desiredHeight });
});
</script>
</body>
</html>`)}`
  );
  qaWindow.once("ready-to-show", () => qaWindow?.showInactive());
}

function positionQaWindow(width: number, height: number) {
  if (!qaWindow) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = display.workArea;
  qaWindow.setPosition(
    Math.round(bounds.x + bounds.width / 2 - width / 2),
    Math.round(bounds.y + bounds.height - height - 26)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 词库自动学习：从"原转写 vs 修正后"中提取因"语音听错"造成的修正对。
// 设计目标：只收"发音相近的短词"，拒绝整句、拒绝语义改写、拒绝通用词。
// ─────────────────────────────────────────────────────────────────────────────

/** 长度上限：1-6 个汉字 或 1-3 个英文单词。 */
const MAX_CN_LENGTH = 6;
const MAX_EN_WORDS = 3;

/** 必被拒绝的虚词 / 通用词 —— 即便发音相似也不应收。 */
const STOP_CHARS = new Set([
  "的", "了", "是", "在", "和", "与", "或", "但", "而", "就",
  "也", "还", "都", "会", "能", "要", "有", "我", "你", "他",
  "她", "它", "们", "这", "那", "哪", "什么", "怎么", "为什么",
  "可以", "需要", "应该", "可能", "一个", "一些", "这个", "那个",
  "我们", "你们", "他们", "它们", "自己", "知道", "觉得", "认为"
]);

/** 判断一个词是否"中文"。 */
function isChineseToken(s: string): boolean {
  return /^[一-鿿㐀-䶿豈-﫿]+$/.test(s);
}

/** 判断一个词是否"纯英文/数字"。 */
function isAlphaNumToken(s: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(s);
}

/**
 * 校验一个修正对（wrong/correct）是否符合"可入词库"标准。
 * 返回 null 表示拒绝；返回原样对象表示通过。
 */
function validateVocabPair(
  wrong: string,
  correct: string
): { original: string; corrected: string } | null {
  const w = wrong.trim();
  const c = correct.trim();
  if (!w || !c || w === c) return null;

  // 1. 形态：必须都是"纯中文"或"纯英文/数字"，不接受混合
  const wIsCn = isChineseToken(w);
  const cIsCn = isChineseToken(c);
  const wIsEn = isAlphaNumToken(w);
  const cIsEn = isAlphaNumToken(c);
  if (wIsCn !== cIsCn) return null; // 中英混搭拒收
  if (!wIsCn && !wIsEn) return null; // 既不是中文也不是英文，拒

  // 2. 长度上限
  if (wIsCn && (w.length > MAX_CN_LENGTH || c.length > MAX_CN_LENGTH)) return null;
  if (wIsEn) {
    const wWords = w.split(/\s+/).filter(Boolean).length;
    const cWords = c.split(/\s+/).filter(Boolean).length;
    if (wWords > MAX_EN_WORDS || cWords > MAX_EN_WORDS) return null;
    if (w.length > 24 || c.length > 24) return null; // 英文总字符兜底
  }

  // 3. 长度下限：1 字的"修正对"几乎都是噪声，拒
  if (wIsCn && (w.length < 2 || c.length < 2)) return null;
  if (wIsEn && (w.length < 2 || c.length < 2)) return null;

  // 4. 拒虚词/通用词（整词命中即拒，单字命中即拒）
  if (STOP_CHARS.has(w) || STOP_CHARS.has(c)) return null;
  for (const ch of w + c) {
    if (STOP_CHARS.has(ch)) return null;
  }

  // 5. 大小写归一
  const wrongNorm = wIsEn ? w.toLowerCase() : w;
  const correctNorm = wIsEn ? c.toLowerCase() : c;
  if (wrongNorm === correctNorm) return null;

  return { original: wrongNorm, corrected: correctNorm };
}

/**
 * 字符串相似度：1 - 归一化编辑距离。
 * 1.0 表示完全相同，0.0 表示完全不同。用于快速判定两个短词是否"形态接近"。
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const maxLen = Math.max(a.length, b.length);
  // Levenshtein 距离（空间优化版）
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return 1 - prev[b.length] / maxLen;
}

/**
 * 用位置对齐 + 滑窗 + 相似度，从两段文本中提取可疑的"短词修正对"。
 * 设计原则：宁少勿多，漏掉的可让 LLM 补，过滤掉的就别再放出来。
 */
function extractCorrections(original: string, edited: string): string[] {
  if (original === edited) return [];
  // 按字 + 英文/数字连续段切分
  const tokenize = (text: string): string[] => {
    const tokens: string[] = [];
    const regex = /[一-鿿㐀-䶿豈-﫿]|[a-zA-Z0-9]+/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) tokens.push(match[0]);
    return tokens;
  };
  const orig = tokenize(original);
  const edit = tokenize(edited);
  const terms: string[] = [];

  // 滑窗：尝试 1-N 字的修正对
  const maxWindow = 6; // 最多尝试 6 字窗
  let ei = 0;
  for (let oi = 0; oi < orig.length && ei < edit.length; oi++) {
    let matched = false;
    // 先尝试等长匹配：1-3 个 token / 1-6 个字
    for (let w = 1; w <= maxWindow && oi + w <= orig.length && ei + w <= edit.length; w++) {
      const oSlice = orig.slice(oi, oi + w).join("");
      const eSlice = edit.slice(ei, ei + w).join("");
      const sim = similarity(oSlice.toLowerCase(), eSlice.toLowerCase());
      // 形态相近但不完全相同
      if (sim >= 0.5 && sim < 1.0) {
        const validated = validateVocabPair(oSlice, eSlice);
        if (validated) {
          terms.push(validated.corrected);
          ei += w;
          oi += w - 1; // for 循环还会 +1
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      // 不同长度：尝试 1 个原文 token 对 N 个修正 token（N=1..3）
      const oTok = orig[oi];
      for (let w = 1; w <= 3 && ei + w <= edit.length; w++) {
        const eSlice = edit.slice(ei, ei + w).join("");
        const v = validateVocabPair(oTok, eSlice);
        if (v) {
          const sim = similarity(oTok.toLowerCase(), eSlice.toLowerCase());
          if (sim >= 0.4 && sim < 1.0) {
            terms.push(v.corrected);
            ei += w;
            oi += 0; // 跳过 0 个 orig
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        ei += 1; // 修正侧前进 1，丢一个 token
      }
    }
  }
  return Array.from(new Set(terms));
}

async function findCorrectionsByAI(original: string, edited: string): Promise<string[]> {
  // 简单比对产出的"修正后的词"列表
  const localTerms = extractCorrections(original, edited);
  if (config.model.provider === "none" || !config.model.apiKey) return localTerms;

  try {
    const response = await callChatModel(
      config,
      config.correctionPrompt,
      `原文本：${original}\n修正后：${edited}\n\n请找出所有被修正过的词汇对。格式：[{"wrong":"错词","correct":"正确词"}]，如果相同则输出 []`
    );
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return localTerms;
    const items = JSON.parse(jsonMatch[0]) as Array<{ wrong?: string; correct?: string }>;
    // LLM 返回的修正对，过 validateVocabPair 拿到 corrected（即"应该学的词"）
    const aiTerms = items
      .map((item) => {
        if (!item.wrong || !item.correct) return null;
        const v = validateVocabPair(item.wrong, item.correct);
        return v ? v.corrected : null;
      })
      .filter((t): t is string => t !== null);
    if (aiTerms.length === 0) return localTerms;

    const deduped = aiTerms.filter((t) => !localTerms.includes(t));
    writeLog("info", "vocabulary", "AI 辅助纠错", {
      simple: localTerms.length,
      ai: aiTerms.length,
      merged: localTerms.length + deduped.length
    });
    return [...localTerms, ...deduped];
  } catch (error) {
    writeLog("warn", "vocabulary", "AI 纠错调用失败，使用简单比对", { error: String(error) });
    return localTerms;
  }
}

async function mergeCorrections(terms: string[]) {
  if (terms.length === 0) return;
  config = loadConfig();
  let changed = false;
  const now = Date.now();
  for (const term of terms) {
    const t = term.trim();
    if (!t) continue;
    if (config.vocabulary.some((v) => v.term === t)) continue; // 已存在 term 则跳过
    config.vocabulary.push({
      id: `voc-auto-${now}-${Math.random().toString(36).slice(2, 8)}`,
      term: t,
      enabled: config.autoLearn,
      source: "correction",
      createdAt: now,
      hitCount: 0
    });
    changed = true;
  }
  if (changed) {
    config = await saveConfig(config);
    writeLog("info", "vocabulary", "自动添加词条", { count: terms.length, autoLearn: config.autoLearn });
    broadcast("config:changed", config);
  }
}

function createRecorderWindow() {
  recorderWindow = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  recorderWindow.loadFile(isDev ? join(process.cwd(), "src/recorder/recorder.html") : join(__dirname, "../recorder/recorder.html"));
  recorderWindow.webContents.once("did-finish-load", async () => {
    recorderReady = true;
    for (const message of pendingRecorderMessages.splice(0)) {
      recorderWindow?.webContents.send(message.channel, message.payload);
    }
    const permissions = await getPermissions();
    if (permissions.microphone === "granted") {
      sendRecorder("recorder:prepare", { language: config.speech.language });
    }
  });
}

let clipboardPickerWindow: BrowserWindow | null = null;
let clipboardPickerReady = false;
let clipboardPickerHideTimer: NodeJS.Timeout | null = null;

function createClipboardPickerWindow() {
  if (clipboardPickerWindow) return;
  // 先用占位尺寸创建，show 之前 positionClipboardPicker 会重新计算
  clipboardPickerWindow = new BrowserWindow({
    width: 380,
    height: 600,
    show: false,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: true,
    backgroundColor: "#1f2937",
    webPreferences: {
      preload: join(__dirname, "../preload/clipboardPicker.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  clipboardPickerWindow.setMenuBarVisibility(false);
  clipboardPickerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  clipboardPickerWindow.loadFile(
    isDev
      ? join(process.cwd(), "src/recorder/clipboard-picker.html")
      : join(__dirname, "../recorder/clipboard-picker.html")
  );

  clipboardPickerWindow.webContents.once("did-finish-load", () => {
    clipboardPickerReady = true;
    pushClipboardHistoryToPicker();
  });

  // 不再用 blur 自动关闭 —— 浮窗里输入框聚焦/失焦的微小切换会误触发关闭，
  // 改由用户按 Esc 或点击外部时显式关闭。
  clipboardPickerWindow.on("closed", () => {
    clipboardPickerWindow = null;
    clipboardPickerReady = false;
  });

  // 屏蔽默认的 webContents 事件，让浮窗更稳
  clipboardPickerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function pushClipboardHistoryToPicker() {
  if (!clipboardPickerWindow || !clipboardPickerReady) return;
  clipboardPickerWindow.webContents.send("clipboard-picker:update", getClipboardHistory());
}

function showClipboardPicker() {
  if (!clipboardPickerWindow) createClipboardPickerWindow();
  const win = clipboardPickerWindow;
  if (!win) return;
  positionClipboardPicker();
  win.show();
  win.focus();
  // 推送最新历史
  if (clipboardPickerReady) pushClipboardHistoryToPicker();
  else win.webContents.once("did-finish-load", () => pushClipboardHistoryToPicker());
}

function hideClipboardPicker() {
  if (!clipboardPickerWindow) return;
  clipboardPickerWindow.hide();
}

function toggleClipboardPicker() {
  if (!clipboardPickerWindow) {
    showClipboardPicker();
    return;
  }
  if (clipboardPickerWindow.isVisible()) hideClipboardPicker();
  else showClipboardPicker();
}

function positionClipboardPicker() {
  if (!clipboardPickerWindow) return;
  const win = clipboardPickerWindow;
  // 找到当前鼠标所在的 display
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  // 浮窗：宽 380px，贴右边；高度占满工作区（顶部 60px 留空不挡 macOS 菜单栏）
  const pickerWidth = 380;
  const topOffset = 60;
  const sideMargin = 8;
  const targetX = x + width - pickerWidth - sideMargin;
  const targetY = y + topOffset;
  const pickerHeight = height - topOffset;
  win.setBounds({ x: targetX, y: targetY, width: pickerWidth, height: pickerHeight });
}

function createTray() {
  const image = nativeImage.createFromPath(assetPath("trayTemplate.png"));
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("AI Voice Input");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示窗口", click: showMainWindow },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function showMainWindow() {
  if (!mainWindow) createMainWindow();
  mainWindow?.show();
  mainWindow?.focus();
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const results: Record<string, boolean> = {};

  const safeRegister = (key: string, accelerator: string, callback: () => void) => {
    try {
      const normalized = accelerator.replace(/\+Period$/i, "+.");
      results[key] = globalShortcut.register(normalized, callback);
    } catch {
      results[key] = false;
    }
  };

  const holdToTalk = startHotkeyWatcher(
    { dictation: config.shortcuts.dictation, question: config.shortcuts.question },
    { onDown: startRecording, onUp: stopRecording }
  );
  results.dictation = holdToTalk.dictation;
  results.question = holdToTalk.question;
  // 同时注册 globalShortcut 以消耗快捷键事件，防止 Ctrl+Q 等系统快捷键被透传
  safeRegister("dictation", config.shortcuts.dictation, () => { /* handled by hotkey watcher */ });
  safeRegister("question", config.shortcuts.question, () => { /* handled by hotkey watcher */ });
  // 剪贴板历史浮窗快捷键：用户在快捷键页可改，默认 Command+Shift+V
  safeRegister("clipboardPicker", config.shortcuts.clipboardPicker, () => { toggleClipboardPicker(); });

  writeLog(Object.values(results).every(Boolean) ? "info" : "warn", "shortcuts", "快捷键注册完成", {
    shortcuts: config.shortcuts,
    results
  });
  broadcast("shortcuts:registered", results);
  return results;
}

function sendRecorder(channel: string, payload?: unknown) {
  if (!recorderWindow) return;
  if (!recorderReady || recorderWindow.webContents.isLoading()) {
    pendingRecorderMessages.push({ channel, payload });
    return;
  }
  recorderWindow.webContents.send(channel, payload);
}

function resetRecorder(reason: string) {
  writeLog("info", "recording", "重置录音设备", { reason });
  sendRecorder("recorder:reset");
  if (status === "recording") {
    activeMode = null;
    recordingStartSent = false;
    setStatus("idle", "录音已中断，请重新按住快捷键");
  }
}

function prepareRecorderAfterResume() {
  setTimeout(async () => {
    const permissions = await getPermissions();
    if (permissions.microphone === "granted") {
      sendRecorder("recorder:prepare", { language: config.speech.language });
    }
  }, 900);
}

function setupPowerEvents() {
  powerMonitor.on("suspend", () => {
    writeLog("info", "power", "系统即将睡眠");
    resetRecorder("system-suspend");
  });
  powerMonitor.on("resume", () => {
    writeLog("info", "power", "系统已唤醒，重建录音和快捷键监听");
    resetRecorder("system-resume");
    registerShortcuts();
    prepareRecorderAfterResume();
  });
  powerMonitor.on("unlock-screen", () => {
    writeLog("info", "power", "屏幕解锁，预热录音设备");
    resetRecorder("screen-unlock");
    prepareRecorderAfterResume();
  });
}

const execFileAsync = promisify(execFile);

async function getFrontmostApp(): Promise<string> {
  if (process.platform !== "darwin") return "";
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to get name of first application process whose frontmost is true'
    ], { timeout: 2000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function startRecording(mode: "dictation" | "question") {
  // 去抖：globalShortcut 偶发会在一次按键里触发两次 down，相隔 1-3ms，
  // 如果和上一次是同一 mode，直接 return 避免状态闪烁。
  const now = Date.now();
  if (lastDownMode === mode && now - lastDownAt < DEBOUNCE_MS) {
    writeLog("debug", "shortcut", "忽略去抖窗口内的重复按下", { mode, deltaMs: now - lastDownAt });
    return;
  }
  lastDownAt = now;
  lastDownMode = mode;
  writeLog("info", "shortcut", "按下快捷键", { mode, status });
  recordingFrontApp = "";
  if (config.autoDetectStyle) {
    recordingFrontApp = await getFrontmostApp();
    writeLog("info", "style", "检测到前台应用", { app: recordingFrontApp });
  }
  if (status !== "idle") {
    // 如果上次录音卡在 recording（recorder:stopped 没回来之类的），允许二次按快捷键
    // 强制清理并重新开始 —— 这是兜底，避免状态机永久卡住。
    if (status === "recording") {
      writeLog("warn", "recording", "检测到录音状态卡住，强制重置后重新开始", { activeMode, requestedMode: mode });
      activeMode = null;
      recordingStartSent = false;
      // 让 recorder 窗口也清空
      sendRecorder("recorder:reset");
      setStatus("idle", "后台待命");
      // 不 return，继续往下走正常的启动流程
    } else if (status === "needs_attention") {
      // 有错误提示但用户想重试 → 允许继续
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
      }
    } else {
      flashError("当前已有任务正在处理", 1600);
      return;
    }
  }

  activeMode = mode;
  stopRequestedWhileStarting = false;
  recordingStartSent = false;
  recordingStartedAt = Date.now();
  setStatus("recording", mode === "dictation" ? "准备录音，松开快捷键结束" : "准备语音问答，松开快捷键结束");

  const permissions = await getPermissions();
  if (permissions.microphone !== "granted" && process.platform === "darwin") {
    const ok = await requestMicrophone();
    if (!ok) {
      activeMode = null;
      flashError("需要麦克风权限才能录音");
      showMainWindow();
      return;
    }
  }

  writeLog("info", "recording", "开始录音", { mode });
  setStatus("recording", mode === "dictation" ? "正在录音，松开快捷键结束" : "正在录音提问，松开快捷键结束");
  sendRecorder("recorder:start", { language: config.speech.language });
  recordingStartSent = true;
  if (stopRequestedWhileStarting) {
    stopRequestedWhileStarting = false;
    sendRecorder("recorder:stop");
  }
}

function stopRecording(mode: "dictation" | "question") {
  writeLog("info", "shortcut", "松开快捷键", { mode, status, activeMode });
  if (activeMode !== mode) return;
  if (!recordingStartSent) {
    stopRequestedWhileStarting = true;
    return;
  }
  writeLog("info", "recording", "停止录音", { mode });
  sendRecorder("recorder:stop");
}

function getAutoDetectedPrompt(): string {
  if (!config.autoDetectStyle || !recordingFrontApp) return config.prompts.polish;
  const styleId = appStyleMap[recordingFrontApp];
  if (!styleId) return config.prompts.polish;
  const profile = config.promptProfiles.find((p) => p.id === styleId);
  if (profile) {
    writeLog("info", "style", "自动匹配样式", { app: recordingFrontApp, style: styleId });
    return profile.prompts.polish;
  }
  return config.prompts.polish;
}

function buildVocabularySuffix(): string {
  const enabled = config.vocabulary.filter((v) => v.enabled);
  if (enabled.length === 0) return "";
  const terms = enabled.map((v) => v.term).join("、");
  return `\n\n【用户词库】以下是用户希望被优先使用的专有名词和术语：${terms}\n请基于上下文判断：如果转写文本中存在同义或近义的其他写法（比如同音字、口语化替换、识别错误），**优先**替换为词库中的正确写法；语义不匹配时不要强行替换。`;
}

async function processAudio(audio: Uint8Array, browserTranscript = "") {
  const mode = activeMode;
  activeMode = null;
  recordingStartSent = false;
  if (!mode) return;
  writeLog("info", "pipeline", `进入处理流程`, { mode });
  const tPipelineStart = Date.now();

  try {
    const seconds = Math.max(0, Math.round((Date.now() - recordingStartedAt) / 1000));
    const recordDurationMs = Date.now() - recordingStartedAt;
    writeLog("info", "timing", "录音阶段", { mode, durationMs: recordDurationMs, audioBytes: audio.byteLength });
    if (recordDurationMs < 650) {
      throw new FriendlyError("录音时间太短了，按住快捷键说完后再松开。");
    }
    if (audio.byteLength < 1200) {
      throw new FriendlyError("这次没有录到声音，请检查麦克风输入，或稍微靠近麦克风再试。", {
        seconds,
        bytes: audio.byteLength
      });
    }

    const tTranscribeStart = Date.now();
    setStatus("transcribing", "正在将语音转换为文字");
    const { text: rawText, audioPath: recordedAudioPath } = await transcribeAudio(audio, config, browserTranscript);
    const tTranscribeEnd = Date.now();
    writeLog("info", "timing", "转写阶段", {
      mode,
      elapsedMs: tTranscribeEnd - tTranscribeStart,
      characters: rawText.length
    });
    let finalText = rawText;

    if (mode === "dictation") {
      let polishMs = 0;
      if (config.model.provider !== "none" && config.model.apiKey) {
        const tPolishStart = Date.now();
        setStatus("generating", "正在润色文本");
        try {
          const stylePrompt = getAutoDetectedPrompt();
          // stylePrompt 已经在出厂/迁移时由 withPolishGuard() 拼好硬约束前缀，
          // 这里不要再叠加 POLISH_GUARD_PREFIX，否则会让约束重复、把风格 prompt 挤远，
          // 导致疑问句被"组织成清晰的指令"改写成陈述句等回归。
          const systemPrompt = stylePrompt + buildVocabularySuffix();
          finalText = await callChatModel(
            config,
            systemPrompt,
            wrapPolishContent(rawText)
          );
          polishMs = Date.now() - tPolishStart;
          writeLog("info", "timing", "润色阶段", { elapsedMs: polishMs, characters: finalText.length });
        } catch (error) {
          const message = readableError(error);
          finalText = rawText;
          polishMs = Date.now() - tPolishStart;
          writeLog("warn", "model", "润色失败，使用转写文本", { error: message, elapsedMs: polishMs });
          notify("润色失败，已使用转写文本", message);
        }
      }
      let reviewMs = 0;
      let skipped = false;
      if (config.reviewBeforePaste && finalText.trim()) {
        if (reviewWindow) {
          writeLog("warn", "review", "校对窗仍在显示，跳过本次校对", { destroyed: reviewWindow.isDestroyed() });
        } else {
          writeLog("info", "review", "进入校对流程");
          const tReviewStart = Date.now();
          setStatus("idle", "请校对文本");
          const result = await showReviewWindow(finalText, rawText, recordedAudioPath, recordingFrontApp ? (appStyleMap[recordingFrontApp] || "") : "");
          reviewMs = Date.now() - tReviewStart;
          writeLog("info", "timing", "校对阶段", { elapsedMs: reviewMs, action: result.action });
          if (result.action === "confirm") {
            if (result.text !== finalText) {
              const originalText = finalText;
              finalText = result.text;
              findCorrectionsByAI(originalText, result.text).then((pairs) => { void mergeCorrections(pairs); });
            }
          } else {
            skipped = true;
            writeLog("info", "review", "用户跳过校对，放弃输入");
          }
          if (process.platform === "darwin") {
            app.hide();
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      }
      if (skipped) {
        writeLog("info", "timing", "全流程耗时", { totalMs: Date.now() - tPipelineStart, skipped: true });
        setStatus("idle", "已放弃");
        return;
      }
      const tDeliverStart = Date.now();
      const report = await deliverText(finalText);
      const deliverMs = Date.now() - tDeliverStart;
      writeLog("info", "timing", "投递阶段", { elapsedMs: deliverMs, ...report });
      if (report.autofillSucceeded) {
        setStatus("idle", "已填入当前输入位置");
      } else {
        setStatus("idle", report.clipboardWritten ? "已写入剪贴板，可手动粘贴" : "投递失败");
      }
      notify("语音输入完成", report.autofillSucceeded ? "已自动填入当前输入位置" : "已写入剪贴板");
      writeLog("info", "timing", "全流程耗时", {
        totalMs: Date.now() - tPipelineStart,
        recordMs: recordDurationMs,
        transcribeMs: tTranscribeEnd - tTranscribeStart,
        polishMs,
        reviewMs,
        deliverMs
      });
    } else {
      setStatus("answering", "正在生成回答");
      finalText = await callChatModel(config, config.prompts.qa, rawText);
      writeLog("info", "qa", "问答完成", { characters: finalText.length });
      notify("语音问答完成", "回答已在独立窗口中显示");
      showQaWindow(rawText, finalText);
    }

    setStatus("idle", "完成");
  } catch (error) {
    const message = readableError(error);
    writeLog("error", "pipeline", "语音流程失败", { error: message, raw: rawError(error) });
    flashError(message);
    notify("AI Voice Input 需要处理", message);
  }
}

function notify(title: string, body: string) {
  writeLog("info", "notification", title, { body: body.slice(0, 500) });
  if (Notification.isSupported()) {
    new Notification({ title, body: body.slice(0, 220) }).show();
  } else {
    showMainWindow();
  }
}

function readableError(error: unknown) {
  if (error instanceof FriendlyError) {
    if (error.detail) writeLog("warn", "friendly-error", error.message, error.detail);
    return error.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/Whisper 没有返回文字|未识别到文字|no speech|blank audio|empty audio/i.test(message)) {
    return "这段录音里没有识别到清晰语音，可以按住快捷键再说一遍。";
  }
  if (/录音数据为空|录音.*过短|audio.*short|too short/i.test(message)) {
    return "录音时间太短了，按住快捷键说完后再松开。";
  }
  if (/fetch failed|network|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|UND_ERR/i.test(message)) {
    return "网络请求失败，请检查模型服务地址、网络连接或代理设置。";
  }
  return message;
}

function rawError(error: unknown) {
  if (error instanceof FriendlyError) return { name: error.name, message: error.message, detail: error.detail };
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return String(error);
}

function setupIpc() {
  ipcMain.handle("app:get-config", () => config);
  ipcMain.handle("app:save-config", async (_event, next: AppConfig) => {
    const prevShortcuts = JSON.stringify(config.shortcuts);
    config = await saveConfig(next);
    if (JSON.stringify(config.shortcuts) !== prevShortcuts) {
      registerShortcuts();
    }
    if (process.platform === "darwin" && app.dock) {
      if (config.showDockIcon) app.dock.show();
      else app.dock.hide();
    }
    return config;
  });
  ipcMain.handle("app:copy-to-clipboard", (_event, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle("permissions:get", () => getPermissions());
  ipcMain.handle("permissions:request-microphone", () => requestMicrophone());
  ipcMain.handle("permissions:open-settings", (_event, kind) => openPermissionSettings(kind));
  ipcMain.handle("shortcuts:register", () => registerShortcuts());
  ipcMain.handle("model:presets", () => modelPresets);
  ipcMain.handle("model:test", async (_event, next: AppConfig) => {
    await callChatModel(next, "你是连接测试助手。只回复 OK。", "请回复 OK");
    return true;
  });
  ipcMain.handle("prompts:defaults", () => defaultPrompts);
  ipcMain.handle("prompts:polish-guard", () => POLISH_GUARD_DISPLAY);
  ipcMain.handle("window:show", showMainWindow);
  ipcMain.handle("logs:list", () => readLogs());
  ipcMain.handle("logs:clear", () => {
    clearLogs();
    writeLog("info", "logs", "日志已清空");
    return readLogs();
  });
  ipcMain.handle("logs:path", () => getLogPath());
  ipcMain.on("qa-window:copy", () => {
    clipboard.writeText(qaWindowAnswer);
    writeLog("info", "qa", "问答结果已复制", { characters: qaWindowAnswer.length });
  });
  ipcMain.on("qa-window:resize", (_event, size: { height?: number }) => {
    if (!qaWindow || typeof size?.height !== "number") return;
    const [width] = qaWindow.getSize();
    const height = Math.min(700, Math.max(180, Math.round(size.height)));
    qaWindow.setSize(width, height, false);
    positionQaWindow(width, height);
  });
  ipcMain.on("qa-window:close", () => qaWindow?.close());
  ipcMain.on("review-window:confirm", (_event, text: string) => {
    if (reviewResolve) {
      reviewResolve({ action: "confirm", text });
      reviewResolve = null;
    }
    reviewWindow?.close();
  });
  ipcMain.on("review-window:skip", () => {
    if (reviewResolve) {
      reviewResolve({ action: "skip", text: "" });
      reviewResolve = null;
    }
    reviewWindow?.close();
  });
  ipcMain.on("review-window:restyle", async (_event, styleId: string) => {
    if (!reviewWindow || !reviewRawText) return;
    const profile = config.promptProfiles.find((p) => p.id === styleId);
    if (!profile) return;
    writeLog("info", "review", "切换润色风格", { styleId, name: profile.name });
    try {
      // profile.prompts.polish 已经由 withPolishGuard() 拼好硬约束，不要再叠加。
      const systemPrompt = profile.prompts.polish + buildVocabularySuffix();
      const polished = await callChatModel(
        config,
        systemPrompt,
        wrapPolishContent(reviewRawText)
      );
      reviewWindow.webContents.send("review:update-text", polished);
    } catch (error) {
      writeLog("warn", "review", "重新润色失败", { error: String(error) });
    }
  });
  ipcMain.on("review-window:resize", (_event, size: { height?: number }) => {
    if (!reviewWindow || typeof size?.height !== "number") return;
    const [width] = reviewWindow.getSize();
    const height = Math.min(460, Math.max(180, Math.round(size.height)));
    reviewWindow.setSize(width, height, false);
  });
  // 剪贴板浮窗
  ipcMain.on("clipboard-picker:pick", (_event, payload: { id: string }) => {
    if (!payload?.id) return;
    const entry = restoreClipboardEntry(payload.id);
    if (entry) {
      writeLog("info", "clipboard-history", "浮窗选中条目已复制回剪贴板", { id: entry.id, length: entry.text.length });
      // 闪一下通知（toast-like），这里直接复用 vocabToast 风格的通知
      notify("已复制到剪贴板", entry.text.length > 60 ? entry.text.slice(0, 60) + "…" : entry.text);
    }
    hideClipboardPicker();
  });
  ipcMain.on("clipboard-picker:close", () => {
    hideClipboardPicker();
  });
  ipcMain.handle("clipboard:history:get", () => getClipboardHistory());
  ipcMain.on("recorder:started", () => setStatus("recording", "正在接收语音，松开快捷键结束"));
  ipcMain.on("recorder:error", (_event, message: string) => {
    activeMode = null;
    recordingStartSent = false;
    writeLog("error", "recording", "录音失败", { error: message });
    flashError(`录音失败：${message}`);
    notify("录音失败", message);
  });
  ipcMain.on("recorder:stopped", (_event, payload: number[] | { bytes: number[]; transcript?: string; empty?: boolean; reason?: string }) => {
    // 兜底：无论 recorder 端送回什么，主进程都要保证状态能回到 idle，
    // 不能再让"录音中"卡住整个状态机。
    const bytes = Array.isArray(payload) ? payload : (payload?.bytes ?? []);
    const transcript = Array.isArray(payload) ? "" : (payload?.transcript ?? "");
    const empty = !Array.isArray(payload) && Boolean(payload?.empty);
    if (empty) {
      // recorder 端因为 processor 没建好等原因发了空数据，
      // 主进程这里不要走讯飞，直接清状态即可。
      writeLog("warn", "recording", "收到空录音数据，已重置状态", { reason: payload?.reason });
      activeMode = null;
      recordingStartSent = false;
      setStatus("idle", "后台待命");
      return;
    }
    processAudio(Uint8Array.from(bytes), transcript);
  });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

app.on("second-instance", showMainWindow);
app.on("before-quit", () => {
  isQuitting = true;
});
app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    const icnsPath = assetPath("icon.icns");
    try { app.dock.setIcon(icnsPath); } catch { /* ignore */ }
    if (config.showDockIcon) {
      app.dock.show();
    } else {
      app.dock.hide();
    }
  }
  setupMediaPermissions();
  setupIpc();
  createMainWindow();
  createOverlayWindow();
  createRecorderWindow();
  createClipboardPickerWindow();
  createTray();
  setupPowerEvents();
  registerShortcuts();
  startClipboardHistoryWatcher();
  // 把剪贴板历史变化实时推送到浮窗
  onClipboardHistoryChange(() => {
    if (clipboardPickerWindow && clipboardPickerWindow.isVisible()) {
      pushClipboardHistoryToPicker();
    }
  });
  setStatus("idle", "后台待命");
  const permissions = await getPermissions();
  if (permissions.microphone !== "granted" || permissions.accessibility !== "granted") {
    showMainWindow();
    mainWindow?.webContents.once("did-finish-load", () => {
      mainWindow?.webContents.send("permissions:attention", permissions);
    });
  }
});

app.on("will-quit", () => {
  stopHotkeyWatcher();
  stopClipboardHistoryWatcher();
  globalShortcut.unregisterAll();
  cleanupRecordings();
});


app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});
