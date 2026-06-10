import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aiVoiceInput", {
  getConfig: () => ipcRenderer.invoke("app:get-config"),
  saveConfig: (config: unknown) => ipcRenderer.invoke("app:save-config", config),
  getState: () => ipcRenderer.invoke("app:get-state"),
  getPermissions: () => ipcRenderer.invoke("permissions:get"),
  requestMicrophone: () => ipcRenderer.invoke("permissions:request-microphone"),
  openPermissionSettings: (kind: string) => ipcRenderer.invoke("permissions:open-settings", kind),
  registerShortcuts: () => ipcRenderer.invoke("shortcuts:register"),
  getModelPresets: () => ipcRenderer.invoke("model:presets"),
  testModel: (config: unknown) => ipcRenderer.invoke("model:test", config),
  getDefaultPrompts: () => ipcRenderer.invoke("prompts:defaults"),
  listLogs: () => ipcRenderer.invoke("logs:list"),
  clearLogs: () => ipcRenderer.invoke("logs:clear"),
  getLogPath: () => ipcRenderer.invoke("logs:path"),
  copyToClipboard: (text: string) => ipcRenderer.invoke("app:copy-to-clipboard", text),
  onStateChanged: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on("state:changed", listener);
    return () => ipcRenderer.removeListener("state:changed", listener);
  },
  onShortcutRegistered: (callback: (result: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("shortcuts:registered", listener);
    return () => ipcRenderer.removeListener("shortcuts:registered", listener);
  },
  onQaResult: (callback: (result: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("qa:result", listener);
    return () => ipcRenderer.removeListener("qa:result", listener);
  },
  onPermissionsAttention: (callback: (result: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on("permissions:attention", listener);
    return () => ipcRenderer.removeListener("permissions:attention", listener);
  },
  onConfigChanged: (callback: (config: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, config: unknown) => callback(config);
    ipcRenderer.on("config:changed", listener);
    return () => ipcRenderer.removeListener("config:changed", listener);
  }
});
