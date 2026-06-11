import { app, clipboard, nativeImage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeLog } from "./logger";

/**
 * 剪贴板历史模块（支持文本 / 图片 / HTML / RTF）
 *
 * - 启动时加载磁盘上的历史（最多 200 条）
 * - 启动后每 800ms 轮询一次剪贴板，对比内容变化 → 追加到队首
 * - 同一内容短时间内重复出现会合并
 * - 长度超过 5000 字符（纯文本）或 5MB（图片 base64）的内容不记录
 * - 图片以 base64 + mimeType 存储到磁盘
 */

export type ClipboardKind = "text" | "image" | "html" | "rtf";

export type ClipboardEntry = {
  id: string;
  kind: ClipboardKind;
  /** 文本类：原文；图片类：""；HTML 类：HTML 文本；RTF 类：RTF 文本 */
  text: string;
  /** 图片类：data URL（"data:image/png;base64,..."）；其他类："" */
  imageDataUrl: string;
  /** HTML/RTF 类的 mimeType（text/html, text/rtf, image/png 等） */
  mimeType: string;
  /** 首次出现在本机剪贴板的时间（毫秒） */
  createdAt: number;
  /** 最近一次被复制回剪贴板的时间（毫秒） */
  lastUsedAt?: number;
};

const MAX_ENTRIES = 200;
const MAX_TEXT_LENGTH = 5000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const POLL_INTERVAL_MS = 800;
const DEDUPE_WINDOW_MS = 500;

let entries: ClipboardEntry[] = [];
let lastSignature = "";
let lastSeenAt = 0;
let pollTimer: NodeJS.Timeout | null = null;
let onChangeListeners: Array<(next: ClipboardEntry[]) => void> = [];

// "刚被复制回剪贴板" 的签名：poll 时如果剪贴板内容和这个匹配，
// 说明是用户从历史里还原的内容，**不要**再入栈。这个窗口要比 DEDUPE_WINDOW_MS 长，
// 因为用户可能浮窗关掉后过几秒才粘贴，又触发系统复制回剪贴板之类的连锁。
let recentlyRestoredSignature = "";
let recentlyRestoredUntil = 0;
const RESTORE_SUPPRESS_MS = 5000;

function historyPath() {
  return join(app.getPath("userData"), "clipboard-history.json");
}

function loadFromDisk() {
  const path = historyPath();
  if (!existsSync(path)) {
    entries = [];
    return;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ClipboardEntry[];
    if (Array.isArray(parsed)) {
      entries = parsed
        .filter(
          (e): e is ClipboardEntry =>
            !!e && typeof e.id === "string" && (typeof e.text === "string" || typeof e.imageDataUrl === "string")
        )
        .slice(0, MAX_ENTRIES);
    } else {
      entries = [];
    }
  } catch (error) {
    writeLog("warn", "clipboard-history", "读取剪贴板历史失败，从空开始", { error: String(error) });
    entries = [];
  }
}

function saveToDisk() {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(historyPath(), JSON.stringify(entries, null, 2), "utf8");
  } catch (error) {
    writeLog("error", "clipboard-history", "写入剪贴板历史失败", { error: String(error) });
  }
}

/**
 * 读剪贴板当前内容 → 统一成 ClipboardEntry（不含 id / createdAt）
 * 返回 null 表示不可记录（空内容 / 太大 / 出错）
 */
function readCurrentEntry(): Omit<ClipboardEntry, "id" | "createdAt"> | null {
  // 1. 图片优先（避免 readText 把图片信息搞丢）
  let img: Electron.NativeImage | null = null;
  try {
    img = clipboard.readImage();
  } catch {
    img = null;
  }
  if (img && !img.isEmpty()) {
    const size = img.getSize();
    // 太大跳过
    const dataUrl = img.toDataURL();
    if (dataUrl.length > MAX_IMAGE_BYTES * 1.4) {
      writeLog("warn", "clipboard-history", "图片过大，跳过", { width: size.width, height: size.height });
      return null;
    }
    return {
      kind: "image",
      text: "",
      imageDataUrl: dataUrl,
      mimeType: "image/png",
      lastUsedAt: undefined
    };
  }

  // 2. HTML —— 但 readHTML 在 macOS 上对纯文本会自动加 "<meta charset='utf-8'>" 前缀，
  // 所以"非空就当 HTML"是错的。正确做法：把 HTML 去标签后跟 plain text 比对——
  // 完全一致就说明只是 plain text 被 Electron 包了头，**不算 HTML**；
  // 不一致（或多了链接/格式化标签）才算真正的 HTML。
  let html = "";
  let text = "";
  try {
    html = clipboard.readHTML() || "";
    text = clipboard.readText() || "";
  } catch {
    html = "";
    text = "";
  }
  const textTrimmed = (text || "").trim();
  if (html && html.trim().length > 0) {
    // 把 HTML 转成纯文本（去标签、合并空白）
    const htmlAsText = stripHtml(html);
    if (textTrimmed.length === 0) {
      // 没有 plain text，但有 HTML（罕见）
      if (html.length > MAX_TEXT_LENGTH * 2) return null;
      return {
        kind: "html",
        text: html,
        imageDataUrl: "",
        mimeType: "text/html"
      };
    }
    // 比对：HTML 剥标签后与 plain text 完全一致 → 这是 plain text（被 Electron 加了 meta 头）
    if (htmlAsText === textTrimmed) {
      if (textTrimmed.length > MAX_TEXT_LENGTH) return null;
      return {
        kind: "text",
        text: textTrimmed,
        imageDataUrl: "",
        mimeType: "text/plain"
      };
    }
    // 不一致 → 这是真正的富文本 HTML
    if (html.length > MAX_TEXT_LENGTH * 2) return null;
    return {
      kind: "html",
      text: html,
      imageDataUrl: "",
      mimeType: "text/html"
    };
  }

  // 3. RTF
  let rtf = "";
  try {
    rtf = clipboard.readRTF();
  } catch {
    rtf = "";
  }
  if (rtf && rtf.trim().length > 0) {
    if (rtf.length > MAX_TEXT_LENGTH * 2) return null;
    return {
      kind: "rtf",
      text: rtf,
      imageDataUrl: "",
      mimeType: "text/rtf"
    };
  }

  // 4. 纯文本
  if (!textTrimmed) return null;
  if (textTrimmed.length > MAX_TEXT_LENGTH) return null;
  return {
    kind: "text",
    text: textTrimmed,
    imageDataUrl: "",
    mimeType: "text/plain"
  };
}

/** 把 entry 折算成"签名"用于 dedupe 判等 */
function signatureOf(e: Omit<ClipboardEntry, "id" | "createdAt">): string {
  if (e.kind === "image") {
    // 图片用 dataURL 前 200 字符 + size 作为指纹（避免每字节都哈希）
    return `image:${e.imageDataUrl.slice(0, 200)}:${e.imageDataUrl.length}`;
  }
  return `${e.kind}:${e.text}`;
}

function notifyChange() {
  for (const cb of onChangeListeners) {
    try {
      cb(entries);
    } catch (error) {
      writeLog("warn", "clipboard-history", "变更回调异常", { error: String(error) });
    }
  }
}

function poll() {
  const current = readCurrentEntry();
  if (!current) {
    // 空剪贴板不算"变化"也不入栈
    return;
  }
  const sig = signatureOf(current);

  // 抑制：从历史里"还原"进来的内容，5 秒内不要再入栈
  if (sig === recentlyRestoredSignature && Date.now() < recentlyRestoredUntil) {
    lastSignature = sig;
    lastSeenAt = Date.now();
    return;
  }

  if (sig === lastSignature) return;
  const now = Date.now();

  // dedupe：同签名在 DEDUPE_WINDOW_MS 内重复 → 只更新时间
  const dup = entries.find((e) => signatureOf(e) === sig);
  if (dup && now - lastSeenAt < DEDUPE_WINDOW_MS) {
    lastSignature = sig;
    lastSeenAt = now;
    dup.lastUsedAt = now;
    saveToDisk();
    notifyChange();
    return;
  }

  lastSignature = sig;
  lastSeenAt = now;

  if (dup) {
    dup.lastUsedAt = now;
    entries = [dup, ...entries.filter((e) => e.id !== dup.id)];
  } else {
    const entry: ClipboardEntry = {
      id: `clip-${now}-${Math.random().toString(36).slice(2, 8)}`,
      ...current,
      createdAt: now
    };
    entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  }
  saveToDisk();
  notifyChange();
}

export function startClipboardHistoryWatcher() {
  loadFromDisk();
  lastSignature = "";
  lastSeenAt = 0;
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  writeLog("info", "clipboard-history", "剪贴板历史监听已启动", { existing: entries.length });
}

export function stopClipboardHistoryWatcher() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function getClipboardHistory(): ClipboardEntry[] {
  return [...entries];
}

export function onClipboardHistoryChange(cb: (next: ClipboardEntry[]) => void): () => void {
  onChangeListeners.push(cb);
  return () => {
    onChangeListeners = onChangeListeners.filter((x) => x !== cb);
  };
}

export function clearClipboardHistory() {
  entries = [];
  saveToDisk();
  notifyChange();
}

/**
 * 把指定 ID 的条目复制回剪贴板。
 * 复制后会更新 lastUsedAt + 移到队首，但**不会**触发下一次轮询当成"新条目"（因为签名相同）。
 */
export function restoreClipboardEntry(id: string): ClipboardEntry | null {
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  const entry = entries[idx];

  try {
    if (entry.kind === "image") {
      const img = nativeImage.createFromDataURL(entry.imageDataUrl);
      if (!img.isEmpty()) {
        clipboard.write({ image: img });
      } else {
        clipboard.writeText(entry.text || "");
      }
    } else if (entry.kind === "html") {
      // HTML 优先用 write({ html, text }) 让接收方能 fallback 到纯文本
      const fallbackText = stripHtml(entry.text);
      clipboard.write({ html: entry.text, text: fallbackText });
    } else if (entry.kind === "rtf") {
      // write({ rtf, text }) RTF 内容
      clipboard.write({ rtf: entry.text, text: entry.text });
    } else {
      clipboard.writeText(entry.text);
    }
  } catch (error) {
    writeLog("error", "clipboard-history", "复制回剪贴板失败", { error: String(error) });
    return null;
  }

  // 抑制接下来 5 秒内的轮询把它当成"新条目"（用户从历史还原的内容不应该再入栈）
  const restoreSig = signatureOf({
    kind: entry.kind,
    text: entry.text,
    imageDataUrl: entry.imageDataUrl,
    mimeType: entry.mimeType
  });
  lastSignature = restoreSig;
  lastSeenAt = Date.now();
  recentlyRestoredSignature = restoreSig;
  recentlyRestoredUntil = Date.now() + RESTORE_SUPPRESS_MS;
  entry.lastUsedAt = Date.now();
  entries = [entry, ...entries.filter((e) => e.id !== entry.id)];
  saveToDisk();
  notifyChange();
  return entry;
}

/** 简单去掉 HTML 标签作为纯文本 fallback */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}