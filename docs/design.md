# AI Voice Input 设计文档

## 1. 技术选型

AI Voice Input 采用 Electron 开发跨平台桌面应用：

- Electron 主进程：后台生命周期、托盘、全局快捷键、权限检查、通知、文本投递、配置持久化。
- Electron 渲染进程：设置界面、权限引导、模型配置、提示词、词库管理。
- 独立隐藏录音窗口：使用 Chromium `navigator.mediaDevices.getUserMedia` 和 `MediaRecorder` 录音，避免主窗口关闭后录音能力失效。
- 本地配置：使用 Electron `app.getPath("userData")` 下的 JSON 文件保存 API Key、提示词、词库、快捷键等用户本地数据。
- 打包：使用 `electron-builder` 生成 macOS DMG；后续可同配置扩展 Windows NSIS 和 Linux AppImage。

## 2. 进程职责

### 2.1 主进程

主进程是应用的稳定后台：

- 创建主窗口、状态浮窗、隐藏录音窗口。
- 注册托盘菜单和应用退出逻辑。
- 注册全局快捷键。
- 检查和引导麦克风、辅助功能、通知、后台常驻相关权限。
- 调用语音转写、模型润色、模型问答。
- 使用剪贴板和系统事件执行文本投递。

主窗口关闭时只隐藏窗口，不退出应用；只有托盘菜单“退出”或显式退出命令才结束后台进程。

### 2.2 渲染进程

渲染进程只通过 preload 暴露的受控 IPC 与主进程通信：

- 不直接访问 Node API。
- 不直接保存敏感配置。
- 不直接操作系统权限。
- 页面展示固定尺寸的滚动区域，长文本不撑开布局。

### 2.3 隐藏录音窗口

录音窗口是一个不可见、不可聚焦的 BrowserWindow：

- 使用 Chromium 原生媒体能力触发系统麦克风授权。
- 录音开始和停止由主进程 IPC 控制。
- 音频结束后将 Blob 转为 ArrayBuffer 回传主进程。

## 3. 权限方案

权限获取必须采用系统认可的方式，而不是依赖不稳定的私有接口。

### 3.1 macOS

- 麦克风权限：
  - 启动时调用 `systemPreferences.getMediaAccessStatus("microphone")` 检测。
  - 未授权时调用 `systemPreferences.askForMediaAccess("microphone")` 触发系统授权弹窗。
  - 被拒绝后通过 `open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"` 打开系统设置。
- 输入控制权限：
  - 自动回填依赖辅助功能权限。
  - Electron 不能可靠静默获取该权限，只能检测并打开系统设置。
  - 检测使用 `systemPreferences.isTrustedAccessibilityClient(false)`。
  - 引导使用 `systemPreferences.isTrustedAccessibilityClient(true)` 或打开 `Privacy_Accessibility` 设置页。
- 通知权限：
  - 使用 Electron `Notification.isSupported()` 检测。
  - 发通知时触发系统通知授权；失败时回退到应用内结果窗口。
- 后台运行：
  - 托盘常驻由 Electron Tray 提供。
  - 主窗口关闭只隐藏，后台快捷键继续由主进程维护。

### 3.2 Windows

- 麦克风权限：
  - 通过 `getUserMedia` 触发系统权限。
  - 失败时打开 `ms-settings:privacy-microphone`。
- 输入控制：
  - 回填优先使用剪贴板加模拟粘贴；失败保留剪贴板。
  - 后续可接入 UI Automation 提升目标应用识别能力。
- 通知权限：
  - 使用 Electron Notification；失败回退应用内提醒。

### 3.3 Linux

- 麦克风权限：
  - 由 PipeWire/PulseAudio 和桌面门户处理。
  - 失败时展示可读错误并提示检查系统隐私设置。
- 输入控制：
  - X11 可模拟粘贴；Wayland 下限制较多，默认剪贴板兜底。
- 通知权限：
  - 使用系统通知服务；失败回退应用内提醒。

## 4. 快捷键方案

第一版注册两个独立全局快捷键：

- 语音输入：默认 `CommandOrControl+Shift+Space`。
- 语音问答：默认 `CommandOrControl+Shift+Period`。

Electron `globalShortcut` 跨平台可靠，但不提供真实 keyup 事件。第一版采用同一快捷键触发“开始/停止”的状态切换，界面文案明确显示当前状态。后续需要严格按住松开语义时，可在主进程接入经过签名和安全审核的 native keyboard hook，并继续保留 globalShortcut 作为兜底。

快捷键修改后立即重新注册；注册失败时标记冲突并保留旧快捷键。

## 5. 录音与转写

录音流程：

1. 主进程收到快捷键。
2. 检查麦克风权限。
3. 通知隐藏录音窗口开始 `MediaRecorder`。
4. 再次触发快捷键时停止录音。
5. 主进程保存临时音频并进入转写。

语音识别采用可插拔 `TranscriptionService`：

- 默认引擎：隐藏录音窗口优先尝试 Chromium Web Speech Recognition，用户无需配置 API Key 或模型资源即可使用可用环境中的免费识别能力。
- 本地引擎：保留本地命令接口，适合接入 whisper.cpp 或 Transformers Whisper。
- 当前 MVP：若浏览器识别不可用且本地引擎未安装，返回可理解错误并保留音频处理状态。
- 后续增强：可在首次启动后下载轻量模型，下载前必须明确告知体积和隐私策略。

## 6. 文本优化与问答

模型服务采用 OpenAI-compatible Chat Completions 形式：

- 预设 DeepSeek V4。
- 预设 GLM-5.1。
- 用户可修改 base URL、接口路径、模型名、温度和 API Key。

未配置模型时：

- 语音输入直接输出转写文本。
- 语音问答提示需要配置模型。

模型失败时：

- 语音输入保留转写文本并投递。
- 语音问答展示失败原因。

## 7. 文本投递

投递顺序：

1. 将最终文本写入系统剪贴板。
2. 如果辅助功能权限可用，尝试模拟粘贴到当前焦点位置。
3. 返回投递报告：目标平台、是否写入剪贴板、是否尝试回填、是否成功、错误原因。

这样即使自动填入失败，用户也不会丢失内容。

## 8. 状态浮窗

状态浮窗是 always-on-top、skip-taskbar、不可聚焦窗口：

- 位于当前显示器底部居中。
- 录音状态带轻微动画。
- 不抢焦点。
- 状态结束后自动隐藏。

## 9. 数据结构

配置包括：

- 快捷键配置。
- 模型配置。
- 语音配置。
- 提示词配置。
- 固定词库和自动词库。
- 权限检测缓存和运行状态。

敏感信息保存在用户本机配置文件；后续可接入系统 Keychain/Credential Manager。

## 10. 验收范围

第一版交付内容：

- 可安装 DMG。
- 后台常驻 Electron 应用。
- 托盘菜单。
- 权限页和启动权限检查。
- 快捷键配置与冲突提示。
- 模型配置与连接测试。
- 提示词、语音、词库页面。
- 状态浮窗。
- 录音链路和转写服务接口。
- 模型优化/问答调用。
- 剪贴板兜底与可用平台上的自动粘贴尝试。
