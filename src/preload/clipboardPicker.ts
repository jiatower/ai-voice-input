import { contextBridge, ipcRenderer } from "electron";

/**
 * 剪贴板历史浮窗专用 preload。
 *
 * 浮窗运行在独立的 BrowserWindow 里，只跟主进程通过 IPC 交换历史数据，
 * 不需要主窗口那一套 API。contextIsolation 开启下，渲染进程的
 * `require("electron")` 拿不到 ipcRenderer，必须通过 contextBridge 暴露。
 */

type ClipboardEntry = {
  id: string;
  text: string;
  createdAt: number;
  lastUsedAt?: number;
};

contextBridge.exposeInMainWorld("clipboardPicker", {
  /** 订阅历史变化（初始化时会立即收到一次） */
  onUpdate: (callback: (entries: ClipboardEntry[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entries: ClipboardEntry[]) => callback(entries);
    ipcRenderer.on("clipboard-picker:update", listener);
    return () => ipcRenderer.removeListener("clipboard-picker:update", listener);
  },
  /** 选中一条：复制回剪贴板 + 关闭浮窗 */
  pick: (id: string) => ipcRenderer.send("clipboard-picker:pick", { id }),
  /** 用户按 Esc / 点关闭 */
  close: () => ipcRenderer.send("clipboard-picker:close")
});
