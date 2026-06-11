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
import { AppConfig, AppStatus, appStyleMap, defaultPrompts, modelPresets } from "./defaults";
import { startHotkeyWatcher, stopHotkeyWatcher } from "./hotkeys";
import { clearLogs, getLogPath, readLogs, writeLog } from "./logger";
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
    minWidth: 960,
    minHeight: 660,
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

function extractCorrections(original: string, edited: string): Array<{ original: string; corrected: string }> {
  if (original === edited) return [];
  const tokenize = (text: string) => {
    const tokens: string[] = [];
    const regex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+|[a-zA-Z0-9]+/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) tokens.push(match[0]);
    return tokens;
  };
  const orig = tokenize(original);
  const edit = tokenize(edited);
  const maxLen = Math.max(orig.length, edit.length);
  const pairs: Array<{ original: string; corrected: string }> = [];
  for (let i = 0; i < maxLen; i++) {
    const o = (orig[i] || "").toLowerCase();
    const e = (edit[i] || "").toLowerCase();
    if (o === e) continue;
    if (o.length < 2 || e.length < 2) continue;
    if (e.length < 3 && /^[a-z]+$/i.test(e)) continue;
    const shorter = o.length < e.length ? o : e;
    const longer = o.length < e.length ? e : o;
    let common = 0;
    for (let j = 0; j < shorter.length; j++) { if (longer.includes(shorter[j])) common += 1; }
    if (common / longer.length > 0.5 || (shorter.length >= 3 && longer.length < 8)) {
      pairs.push({ original: orig[i] || "", corrected: edit[i] || "" });
    }
  }
  return pairs;
}

async function findCorrectionsByAI(original: string, edited: string): Promise<Array<{ original: string; corrected: string }>> {
  const pairs = extractCorrections(original, edited);
  if (config.model.provider === "none" || !config.model.apiKey) return pairs;

  try {
    const response = await callChatModel(
      config,
      config.correctionPrompt,
      `原文本：${original}\n修正后：${edited}\n\n请找出所有被修正过的词汇对。格式：[{"wrong":"错词","correct":"正确词"}]，如果相同则输出 []`
    );
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return pairs;
    const items = JSON.parse(jsonMatch[0]) as Array<{ wrong?: string; correct?: string }>;
    const aiPairs = items
      .filter((item) => item.wrong && item.correct && item.wrong !== item.correct)
      .map((item) => ({ original: item.wrong!, corrected: item.correct! }));
    if (aiPairs.length === 0) return pairs;

    const deduped = aiPairs.filter((ai) =>
      !pairs.some((p) => p.original === ai.original && p.corrected === ai.corrected)
    );
    writeLog("info", "vocabulary", "AI 辅助纠错", { simple: pairs.length, ai: aiPairs.length, merged: pairs.length + deduped.length });
    return [...pairs, ...deduped];
  } catch (error) {
    writeLog("warn", "vocabulary", "AI 纠错调用失败，使用简单比对", { error: String(error) });
    return pairs;
  }
}

async function mergeCorrections(pairs: Array<{ original: string; corrected: string }>) {
  if (pairs.length === 0) return;
  config = loadConfig();
  let changed = false;
  for (const pair of pairs) {
    const dup = config.vocabulary.find(
      (v) => v.term === pair.corrected && v.aliases === pair.original
    );
    if (dup) continue;
    const existing = config.vocabulary.find((v) => v.term === pair.corrected);
    if (existing) {
      if (!existing.aliases.includes(pair.original)) {
        existing.aliases = [existing.aliases, pair.original].filter(Boolean).join(",");
        changed = true;
      }
    } else {
      config.vocabulary.push({
        id: crypto.randomUUID(),
        term: pair.corrected,
        aliases: pair.original,
        enabled: config.autoLearn,
        source: "correction"
      });
      changed = true;
    }
  }
  if (changed) {
    config = await saveConfig(config);
    writeLog("info", "vocabulary", "\u81ea\u52a8\u6dfb\u52a0\u7ea0\u6b63\u8bcd\u6761", { count: pairs.length, autoLearn: config.autoLearn });
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
  safeRegister("vocabulary", config.shortcuts.vocabulary, showMainWindow);

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
  writeLog("info", "shortcut", "按下快捷键", { mode, status });
  recordingFrontApp = "";
  if (config.autoDetectStyle) {
    recordingFrontApp = await getFrontmostApp();
    writeLog("info", "style", "检测到前台应用", { app: recordingFrontApp });
  }
  if (status !== "idle") {
    if (status !== "recording" || activeMode !== mode) flashError("当前已有任务正在处理", 1600);
    return;
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
  return `\n\n请注意不要改错以下专有名词和术语：${terms}`;
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
          const prompt = getAutoDetectedPrompt();
          finalText = await callChatModel(
            config,
            prompt + buildVocabularySuffix(),
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
      const polished = await callChatModel(
        config,
        profile.prompts.polish + buildVocabularySuffix(),
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
  ipcMain.on("recorder:started", () => setStatus("recording", "正在接收语音，松开快捷键结束"));
  ipcMain.on("recorder:error", (_event, message: string) => {
    activeMode = null;
    recordingStartSent = false;
    writeLog("error", "recording", "录音失败", { error: message });
    flashError(`录音失败：${message}`);
    notify("录音失败", message);
  });
  ipcMain.on("recorder:stopped", (_event, payload: number[] | { bytes: number[]; transcript?: string }) => {
    const bytes = Array.isArray(payload) ? payload : payload.bytes;
    const transcript = Array.isArray(payload) ? "" : payload.transcript ?? "";
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
  createTray();
  setupPowerEvents();
  registerShortcuts();
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
  globalShortcut.unregisterAll();
  cleanupRecordings();
});

app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});
