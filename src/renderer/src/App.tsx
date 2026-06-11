import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Home,
  Keyboard,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ScrollText,
  Settings,
  Sparkles,
  Trash2,
  Wand2
} from "lucide-react";
import "./styles/app.css";

type AppStatus =
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "generating"
  | "answering"
  | "needs_attention";

type Config = {
  shortcuts: { dictation: string; question: string; clipboardPicker: string };
  model: {
    provider: "none" | "deepseek" | "glm" | "custom";
    baseUrl: string;
    path: string;
    model: string;
    apiKey: string;
    temperature: number;
  };
  speech: {
    language: "auto" | "zh" | "en";
    mode: "local" | "cloud";
    priority: "speed" | "accuracy";
    advancedOpen: boolean;
    localEnginePath: string;
  };
  iflytek: {
    appId: string;
    apiKey: string;
    apiSecret: string;
  };
  prompts: { polish: string; qa: string };
  correctionPrompt: string;
  promptProfiles: Array<{ id: string; name: string; prompts: { polish: string; qa: string } }>;
  activePromptProfileId: string;
  vocabulary: Array<{ id: string; term: string; enabled: boolean; source?: "manual" | "correction"; createdAt?: number; hitCount?: number }>;
  autoLearn: boolean;
  reviewBeforePaste: boolean;
  autoDetectStyle: boolean;
  showDockIcon: boolean;
  saveHistory: boolean;
};

type PermissionState = {
  microphone: string;
  accessibility: string;
  notifications: string;
  background: string;
  platform: string;
};

type LogEntry = {
  id: string;
  time: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
  data?: unknown;
};

declare global {
  interface Window {
    aiVoiceInput: {
      getConfig: () => Promise<Config>;
      saveConfig: (config: Config) => Promise<Config>;
      getState: () => Promise<{ status: AppStatus }>;
      getPermissions: () => Promise<PermissionState>;
      requestMicrophone: () => Promise<boolean>;
      openPermissionSettings: (kind: string) => Promise<void>;
      registerShortcuts: () => Promise<Record<string, boolean>>;
      getModelPresets: () => Promise<Record<string, Partial<Config["model"]>>>;
      testModel: (config: Config) => Promise<boolean>;
      getDefaultPrompts: () => Promise<Config["prompts"]>;
      getPolishGuard: () => Promise<string>;
      listLogs: () => Promise<LogEntry[]>;
      clearLogs: () => Promise<LogEntry[]>;
      getLogPath: () => Promise<string>;
      copyToClipboard: (text: string) => Promise<void>;
      onStateChanged: (callback: (state: { status: AppStatus; detail: string }) => void) => () => void;
      onShortcutRegistered: (callback: (result: Record<string, boolean>) => void) => () => void;
      onQaResult: (callback: (result: unknown) => void) => () => void;
      onPermissionsAttention: (callback: (state: PermissionState) => void) => () => void;
      onConfigChanged: (callback: (config: Config) => void) => () => void;
      onVocabularyAdded: (callback: (info: { term: string; duplicate: boolean }) => void) => () => void;
    };
  }
}

const nav = [
  { id: "home", label: "首页", icon: Home },
  { id: "shortcuts", label: "快捷键", icon: Keyboard },
  { id: "model", label: "模型", icon: Sparkles },
  { id: "speech", label: "语音", icon: Mic },
  { id: "prompts", label: "提示词", icon: Wand2 },
  { id: "vocabulary", label: "词库", icon: BookOpen },
  { id: "logs", label: "日志", icon: ScrollText },
  { id: "permissions", label: "权限", icon: Bell }
] as const;

const statusText: Record<AppStatus, string> = {
  idle: "空闲",
  recording: "正在录音",
  transcribing: "正在转写",
  thinking: "正在思考",
  generating: "正在生成",
  answering: "正在回复",
  needs_attention: "需要处理"
};

function acceleratorFromEvent(event: React.KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  const parts: string[] = [];
  if (event.metaKey) parts.push("Command");
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const mapped: Record<string, string> = { " ": "Space", ".": ".", ",": ",", "/": "/", ";": ";", "'": "'" };
  const key = mapped[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key.replace("Arrow", ""));
  if (!["Meta", "Control", "Alt", "Shift"].includes(event.key)) parts.push(key);
  return parts.length >= 2 ? parts.join("+") : "";
}

function App() {
  const [page, setPage] = useState<(typeof nav)[number]["id"]>("home");
  const [config, setConfig] = useState<Config | null>(null);
  const [status, setStatus] = useState<AppStatus>("idle");
  const [detail, setDetail] = useState("后台待命");
  const [permissions, setPermissions] = useState<PermissionState | null>(null);
  const [shortcutState, setShortcutState] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [vocabToast, setVocabToast] = useState<string | null>(null);

  useEffect(() => {
    window.aiVoiceInput.getConfig().then(setConfig);
    window.aiVoiceInput.getState().then((state) => setStatus(state.status));
    refreshPermissions();
    window.aiVoiceInput.registerShortcuts().then(setShortcutState);
    const offState = window.aiVoiceInput.onStateChanged((state) => {
      setStatus(state.status);
      setDetail(state.detail);
    });
    const offShortcuts = window.aiVoiceInput.onShortcutRegistered(setShortcutState);
    const offPerms = window.aiVoiceInput.onPermissionsAttention((state) => {
      setPermissions(state);
      setPage("permissions");
    });
    const offConfig = window.aiVoiceInput.onConfigChanged((next) => setConfig(next));
    const offVocab = window.aiVoiceInput.onVocabularyAdded((info) => {
      setConfig((prev) => {
        if (!prev) return prev;
        if (info.duplicate) return prev; // 已存在，配置没变
        // 主进程已经写盘，这里同步本地状态让 UI 立刻反映
        return {
          ...prev,
          vocabulary: [
            ...prev.vocabulary,
            { id: `voc-shortcut-${Date.now()}`, term: info.term, enabled: true, source: "manual", createdAt: Date.now(), hitCount: 0 }
          ]
        };
      });
      setVocabToast(info.duplicate ? `「${info.term}」已在词库中` : `已加入「${info.term}」`);
      // 自动隐藏
      setTimeout(() => setVocabToast(null), 2200);
    });
    return () => {
      offState();
      offShortcuts();
      offPerms();
      offConfig();
      offVocab();
    };
  }, []);

  async function refreshPermissions() {
    setPermissions(await window.aiVoiceInput.getPermissions());
  }

  async function save(next = config) {
    if (!next) return;
    setSaving(true);
    try {
      setConfig(await window.aiVoiceInput.saveConfig(next));
    } finally {
      setSaving(false);
    }
  }

  function update(mutator: (current: Config) => Config) {
    if (!config) return;
    setConfig(mutator(config));
  }

  const enabledTerms = useMemo(() => config?.vocabulary.filter((item) => item.enabled).length ?? 0, [config]);

  if (!config) {
    return <div className="boot">正在启动 AI Voice Input...</div>;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">AI</div>
          <div>
            <strong>AI Voice Input</strong>
            <span>后台语音输入助手</span>
          </div>
        </div>
        <nav>
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => setPage(item.id)}>
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <h1>{nav.find((item) => item.id === page)?.label}</h1>
            <p>{statusText[status]} · {detail}</p>
          </div>
          <div className={`saveIndicator ${saving ? "saving" : "saved"}`} title={saving ? "正在保存…" : "所有更改已自动保存"}>
            <span className="dot" />
            <span className="label">{saving ? "保存中" : "已保存"}</span>
          </div>
        </header>

        {page === "home" && (
          <>
            <section className="grid two">
              <InfoCard title="运行状态" icon={<Mic size={20} />}>
                <div className={`statusBadge ${status}`}>{statusText[status]}</div>
                <p className="muted">主窗口关闭后应用仍在后台运行，托盘菜单可重新打开窗口。</p>
              </InfoCard>
              <InfoCard title="关键配置" icon={<Settings size={20} />}>
                <dl className="facts">
                  <dt>语音输入</dt><dd>{config.shortcuts.dictation}</dd>
                  <dt>语音问答</dt><dd>{config.shortcuts.question}</dd>
                  <dt>当前模型</dt><dd>{config.model.provider === "none" ? "未配置" : config.model.model}</dd>
                  <dt>识别模式</dt><dd>{config.speech.priority === "speed" ? "速度优先" : "准确率优先"}</dd>
                  <dt>启用词条</dt><dd>{enabledTerms}</dd>
                </dl>
              </InfoCard>
            </section>
            <section className="panel">
              <div className="row">
                <div>
                  <strong>自动匹配提示词风格</strong>
                  <span>根据当前所在 App 自动选择合适的提示词（微信→口头聊天，VS Code→AI 指令等）</span>
                </div>
                <label className="switch"><input type="checkbox" checked={config.autoDetectStyle} onChange={(e) => { update((c) => ({ ...c, autoDetectStyle: e.target.checked })); save({ ...config, autoDetectStyle: e.target.checked }); }} /></label>
              </div>
              <div className="row">
                <div>
                  <strong>发送前校对</strong>
                  <span>润色后弹出校对窗口，修改后自动将纠正加入词库</span>
                </div>
                <label className="switch"><input type="checkbox" checked={config.reviewBeforePaste} onChange={(e) => { update((c) => ({ ...c, reviewBeforePaste: e.target.checked })); save({ ...config, reviewBeforePaste: e.target.checked }); }} /></label>
              </div>
              <div className="row">
                <div>
                  <strong>在 Dock 栏显示图标</strong>
                  <span>开启后应用图标在 Dock 栏可见，关闭后仅保留托盘图标</span>
                </div>
                <label className="switch"><input type="checkbox" checked={config.showDockIcon} onChange={(e) => { update((c) => ({ ...c, showDockIcon: e.target.checked })); save({ ...config, showDockIcon: e.target.checked }); }} /></label>
              </div>
            </section>
          </>
        )}

        {page === "shortcuts" && (
          <ShortcutPage config={config} update={update} save={save} shortcutState={shortcutState} />
        )}

        {page === "model" && <ModelPage config={config} update={update} save={save} />}
        {page === "speech" && <SpeechPage config={config} update={update} />}
        {page === "prompts" && <PromptsPage config={config} update={update} save={save} />}
        {page === "vocabulary" && <VocabularyPage config={config} update={update} />}
        {page === "logs" && <LogsPage />}
        {page === "permissions" && (
          <PermissionsPage permissions={permissions} refresh={refreshPermissions} />
        )}
      </main>

      {vocabToast && (
        <div className="vocabToast" role="status" aria-live="polite">
          <span>{vocabToast}</span>
        </div>
      )}
    </div>
  );
}

function InfoCard(props: { title: string; icon: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <article className={`card ${props.wide ? "wide" : ""}`}>
      <div className="cardTitle">
        {props.icon}
        <h2>{props.title}</h2>
      </div>
      {props.children}
    </article>
  );
}

function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LogEntry["level"] | "all">("all");
  const [query, setQuery] = useState("");
  const [logPath, setLogPath] = useState("");
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setLogs(await window.aiVoiceInput.listLogs());
      setLogPath(await window.aiVoiceInput.getLogPath());
    } finally {
      setLoading(false);
    }
  }

  async function clear() {
    setLoading(true);
    try {
      setLogs(await window.aiVoiceInput.clearLogs());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return logs.filter((entry) => {
      if (level !== "all" && entry.level !== level) return false;
      if (!text) return true;
      const haystack = [
        entry.time,
        entry.level,
        entry.scope,
        entry.message,
        entry.data === undefined ? "" : JSON.stringify(entry.data)
      ].join(" ").toLowerCase();
      return haystack.includes(text);
    });
  }, [logs, level, query]);

  return (
    <section className="panel logsPanel">
      <div className="logToolbar">
        <div className="logFilters">
          <Select value={level} onChange={(value) => setLevel(value as typeof level)}>
            <option value="all">全部级别</option>
            <option value="error">错误</option>
            <option value="warn">警告</option>
            <option value="info">信息</option>
            <option value="debug">调试</option>
          </Select>
          <input placeholder="搜索时间、模块、消息或详情" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="actions">
          <button className="secondary" onClick={refresh} disabled={loading}>
            {loading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
            刷新
          </button>
          <button className="secondary danger" onClick={clear} disabled={loading}>
            <Trash2 size={16} />
            清空
          </button>
        </div>
      </div>

      <div className="logPath">
        <span>日志文件</span>
        <code>{logPath || "正在读取..."}</code>
      </div>

      <div className="logList">
        {filtered.length === 0 ? (
          <div className="emptyState">暂无匹配日志</div>
        ) : (
          filtered.map((entry) => (
            <article className={`logItem ${entry.level}`} key={entry.id}>
              <div className="logMeta">
                <span className={`logLevel ${entry.level}`}>{levelLabel(entry.level)}</span>
                <span>{formatLogTime(entry.time)}</span>
                <span>{entry.scope}</span>
                <button className="copyLog" title="复制该条" onClick={(e) => {
                  const text = JSON.stringify({ time: entry.time, level: entry.level, scope: entry.scope, message: entry.message, data: entry.data }, null, 2);
                  window.aiVoiceInput.copyToClipboard(text);
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.classList.add("copied");
                  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>已复制';
                  setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'; }, 1200);
                }}>
                  <Copy size={12} />
                </button>
              </div>
              <div className="logMessage">{entry.message}</div>
              {entry.data !== undefined && <pre>{JSON.stringify(entry.data, null, 2)}</pre>}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function levelLabel(level: LogEntry["level"]) {
  return { debug: "调试", info: "信息", warn: "警告", error: "错误" }[level];
}

function formatLogTime(time: string) {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return time;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function ShortcutPage(props: {
  config: Config;
  update: (mutator: (current: Config) => Config) => void;
  save: (next?: Config) => Promise<void>;
  shortcutState: Record<string, boolean>;
}) {
  const [capturing, setCapturing] = useState<keyof Config["shortcuts"] | null>(null);
  const rows: Array<[keyof Config["shortcuts"], string]> = [
    ["dictation", "语音输入"],
    ["question", "语音问答"],
    ["clipboardPicker", "剪贴板历史"]
  ];

  return (
    <section className="panel">
      {rows.map(([key, label]) => (
        <div className="row" key={key}>
          <div>
            <strong>{label}</strong>
            <span>{props.shortcutState[key] === false ? "注册失败，可能已被占用" : "已注册"}</span>
          </div>
          <button
            className={`keyButton ${capturing === key ? "capturing" : ""}`}
            onClick={() => setCapturing(key)}
            onKeyDown={(event) => {
              if (capturing !== key) return;
              if (event.key === "Escape") {
                setCapturing(null);
                return;
              }
              const nextKey = acceleratorFromEvent(event);
              if (!nextKey) return;
              const next = {
                ...props.config,
                shortcuts: { ...props.config.shortcuts, [key]: nextKey }
              };
              props.update(() => next);
              props.save(next);
              setCapturing(null);
            }}
          >
            <Keyboard size={16} />
            {capturing === key ? "按下组合键，Esc 取消" : props.config.shortcuts[key]}
          </button>
        </div>
      ))}
    </section>
  );
}

function ModelPage(props: { config: Config; update: (m: (c: Config) => Config) => void; save: (next?: Config) => Promise<void> }) {
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");

  async function applyPreset(provider: "none" | "deepseek" | "glm" | "custom") {
    if (provider === "none") {
      props.update((config) => ({ ...config, model: { ...config.model, provider } }));
      return;
    }
    const presets = await window.aiVoiceInput.getModelPresets();
    props.update((config) => ({ ...config, model: { ...config.model, ...presets[provider], provider } }));
  }

  async function test() {
    setTesting(true);
    setMessage("");
    try {
      await window.aiVoiceInput.testModel(props.config);
      setMessage("连接成功");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="panel form">
      <label>服务预设</label>
      <div className="segmented">
        {(["none", "deepseek", "glm", "custom"] as const).map((provider) => (
          <button key={provider} className={props.config.model.provider === provider ? "active" : ""} onClick={() => applyPreset(provider)}>
            {provider === "none" ? "未配置" : provider === "deepseek" ? "DeepSeek V4" : provider === "glm" ? "GLM-5.1" : "自定义"}
          </button>
        ))}
      </div>
      <Input label="服务地址" value={props.config.model.baseUrl} onChange={(baseUrl) => props.update((c) => ({ ...c, model: { ...c.model, baseUrl } }))} />
      <Input label="接口路径" value={props.config.model.path} onChange={(path) => props.update((c) => ({ ...c, model: { ...c.model, path } }))} />
      <Input label="模型名称" value={props.config.model.model} onChange={(model) => props.update((c) => ({ ...c, model: { ...c.model, model } }))} />
      <Input label="API Key" type="password" value={props.config.model.apiKey} onChange={(apiKey) => props.update((c) => ({ ...c, model: { ...c.model, apiKey } }))} />
      <label>温度 {props.config.model.temperature}</label>
      <input type="range" min="0" max="1" step="0.1" value={props.config.model.temperature} onChange={(e) => props.update((c) => ({ ...c, model: { ...c.model, temperature: Number(e.target.value) } }))} />
      <div className="actions">
        <button className="secondary" onClick={test} disabled={testing}>
          {testing ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
          测试连接
        </button>
        <span className="hint">{message || "未配置模型时，语音转写仍可用，但不会自动润色或问答。"}</span>
      </div>
    </section>
  );
}

function SpeechPage(props: { config: Config; update: (m: (c: Config) => Config) => void }) {
  return (
    <section className="panel form">
      <label>识别语言</label>
      <Select value={props.config.speech.language} onChange={(language) => props.update((c) => ({ ...c, speech: { ...c.speech, language: language as Config["speech"]["language"] } }))}>
        <option value="auto">自动识别</option>
        <option value="zh">中文</option>
        <option value="en">英文</option>
      </Select>
      <label>识别模式</label>
      <div className="segmented">
        <button className={props.config.speech.priority === "speed" ? "active" : ""} onClick={() => props.update((c) => ({ ...c, speech: { ...c.speech, priority: "speed" } }))}>速度优先</button>
        <button className={props.config.speech.priority === "accuracy" ? "active" : ""} onClick={() => props.update((c) => ({ ...c, speech: { ...c.speech, priority: "accuracy" } }))}>准确率优先</button>
      </div>
      <hr />
      <p className="hint">
        讯飞语音听写 API。从控制台获取：<br />
        1. 打开 <a href="#" onClick={(e) => { e.preventDefault(); }}>console.xfyun.cn/app/myapp</a> → 找到应用<br />
        2. 左侧点「语音听写（流式版）」→ 查看 APPID、APIKey、APISecret<br />
        留空则无法使用语音识别。
      </p>
      <Input label="讯飞 APPID" value={props.config.iflytek.appId} onChange={(appId) => props.update((c) => ({ ...c, iflytek: { ...c.iflytek, appId } }))} />
      <p className="hint">控制台应用的唯一标识，见「我的应用」列表</p>
      <Input label="讯飞 APIKey" type="password" value={props.config.iflytek.apiKey} onChange={(apiKey) => props.update((c) => ({ ...c, iflytek: { ...c.iflytek, apiKey } }))} />
      <p className="hint">在「语音听写（流式版）」服务详情页获取</p>
      <Input label="讯飞 APISecret" type="password" value={props.config.iflytek.apiSecret} onChange={(apiSecret) => props.update((c) => ({ ...c, iflytek: { ...c.iflytek, apiSecret } }))} />
      <p className="hint">在「语音听写（流式版）」服务详情页获取</p>
    </section>
  );
}

function PromptsPage(props: { config: Config; update: (m: (c: Config) => Config) => void; save: (next?: Config) => Promise<void> }) {
  const activeProfile = props.config.promptProfiles.find((profile) => profile.id === props.config.activePromptProfileId) ?? props.config.promptProfiles[0];
  const [polishGuard, setPolishGuard] = useState<string>("");
  const [showGuard, setShowGuard] = useState(false);
  // 顶部 tab：polish / qa / correction
  const [tab, setTab] = useState<"polish" | "qa" | "correction">("polish");

  useEffect(() => {
    void window.aiVoiceInput.getPolishGuard().then((text) => {
      if (typeof text === "string") setPolishGuard(text);
    });
  }, []);

  function persistAll() { void window.aiVoiceInput.saveConfig(props.config); }

  function updateProfiles(mutator: (profiles: Config["promptProfiles"]) => Config["promptProfiles"], activeId = props.config.activePromptProfileId) {
    const promptProfiles = mutator(props.config.promptProfiles);
    const activePromptProfileId = promptProfiles.some((profile) => profile.id === activeId) ? activeId : promptProfiles[0]?.id ?? "default";
    const active = promptProfiles.find((profile) => profile.id === activePromptProfileId) ?? promptProfiles[0];
    const next = { ...props.config, promptProfiles, activePromptProfileId, prompts: active?.prompts ?? props.config.prompts };
    props.update(() => next);
  }

  function select(id: string) {
    const profile = props.config.promptProfiles.find((item) => item.id === id);
    if (!profile) return;
    const next = { ...props.config, activePromptProfileId: id, prompts: profile.prompts };
    props.update(() => next);
    void window.aiVoiceInput.saveConfig(next);
  }

  function add() {
    const id = crypto.randomUUID();
    const name = `提示词 ${props.config.promptProfiles.length + 1}`;
    updateProfiles((profiles) => [...profiles, { id, name, prompts: props.config.prompts }], id);
    persistAll();
  }

  function duplicate() {
    if (!activeProfile) return;
    const id = crypto.randomUUID();
    updateProfiles(
      (profiles) => [...profiles, { id, name: `${activeProfile.name} 副本`, prompts: { ...activeProfile.prompts } }],
      id
    );
    persistAll();
  }

  function remove(id: string) {
    if (props.config.promptProfiles.length <= 1) return;
    updateProfiles((profiles) => profiles.filter((profile) => profile.id !== id));
    persistAll();
  }

  function rename(name: string) {
    if (!activeProfile) return;
    updateProfiles((profiles) => profiles.map((profile) => profile.id === activeProfile.id ? { ...profile, name } : profile));
    persistAll();
  }

  function updatePrompt(key: keyof Config["prompts"], value: string) {
    if (!activeProfile) return;
    updateProfiles((profiles) => profiles.map((profile) => {
      if (profile.id !== activeProfile.id) return profile;
      return { ...profile, prompts: { ...profile.prompts, [key]: value } };
    }));
  }

  function updateCorrection(value: string) {
    props.update((c) => ({ ...c, correctionPrompt: value }));
  }

  async function restore() {
    const prompts = await window.aiVoiceInput.getDefaultPrompts();
    if (!activeProfile) return;
    const promptProfiles = props.config.promptProfiles.map((profile) => (
      profile.id === activeProfile.id ? { ...profile, prompts } : profile
    ));
    const next = { ...props.config, promptProfiles, prompts };
    props.update(() => next);
    void window.aiVoiceInput.saveConfig(next);
  }

  async function restoreCorrection() {
    const defaults = await window.aiVoiceInput.getDefaultPrompts();
    // 默认 correctionPrompt 不在 prompts 里，但可以通过 IPC 拿——这里直接用一个固定的"恢复默认"逻辑
    const fallback = "你是语音识别纠错助手，专职发现\"因发音相近被识别错\"的短词。\n\n【输出格式】仅输出 JSON 数组：[{\"wrong\":\"错词\",\"correct\":\"正确词\"}]，无任何修正对时输出 []。";
    const next = { ...props.config, correctionPrompt: fallback };
    props.update(() => next);
    void window.aiVoiceInput.saveConfig(next);
    // 防止 unused warning
    void defaults;
  }

  if (!activeProfile) {
    return <section className="panel">暂无提示词配置</section>;
  }

  return (
    <section className="panel promptPanel">
      <div className="promptSidebar">
        <div className="actions">
          <button className="primary compact" onClick={add}><Plus size={16} />新增</button>
          <button className="secondary compact" onClick={duplicate}><Copy size={16} />复制</button>
        </div>
        <div className="promptList">
          {props.config.promptProfiles.map((profile) => (
            <button
              key={profile.id}
              className={profile.id === activeProfile.id ? "active" : ""}
              onClick={() => select(profile.id)}
            >
              <span>{profile.name}</span>
              <small>{profile.id === activeProfile.id ? "正在使用" : "可切换"}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="promptEditor">
        <div className="promptTabs">
          <button className={tab === "polish" ? "active" : ""} onClick={() => setTab("polish")}>润色</button>
          <button className={tab === "qa" ? "active" : ""} onClick={() => setTab("qa")}>问答</button>
          <button className={tab === "correction" ? "active" : ""} onClick={() => setTab("correction")}>纠错</button>
        </div>

        {tab === "polish" && (
          <div className="promptTabPane">
            <Input label="名称" value={activeProfile.name} onChange={rename} onBlur={persistAll} />
            <label>润色提示词（仅风格部分；系统会自动在前面追加硬约束前缀）</label>
            <textarea value={activeProfile.prompts.polish} onChange={(e) => updatePrompt("polish", e.target.value)} onBlur={persistAll} />
            {polishGuard && (
              <details className="systemGuard" open={showGuard} onToggle={(e) => setShowGuard((e.target as HTMLDetailsElement).open)}>
                <summary>
                  <span>系统硬约束（自动追加，用户不可改）</span>
                  <ChevronRight size={14} className="chevron" />
                </summary>
                <pre className="guardText">{polishGuard}</pre>
              </details>
            )}
            <div className="actions">
              <button className="secondary" onClick={restore}><RotateCcw size={16} />恢复默认</button>
              <button
                className="secondary danger"
                onClick={() => remove(activeProfile.id)}
                disabled={props.config.promptProfiles.length <= 1}
              >
                <Trash2 size={16} />
                删除
              </button>
            </div>
          </div>
        )}

        {tab === "qa" && (
          <div className="promptTabPane">
            <Input label="名称" value={activeProfile.name} onChange={rename} onBlur={persistAll} />
            <label>问答提示词</label>
            <textarea value={activeProfile.prompts.qa} onChange={(e) => updatePrompt("qa", e.target.value)} onBlur={persistAll} />
            <div className="actions">
              <button className="secondary" onClick={restore}><RotateCcw size={16} />恢复默认</button>
              <button
                className="secondary danger"
                onClick={() => remove(activeProfile.id)}
                disabled={props.config.promptProfiles.length <= 1}
              >
                <Trash2 size={16} />
                删除
              </button>
            </div>
          </div>
        )}

        {tab === "correction" && (
          <div className="promptTabPane">
            <label>纠错提示词（全局，所有风格共用）</label>
            <textarea
              value={props.config.correctionPrompt}
              onChange={(e) => updateCorrection(e.target.value)}
              onBlur={persistAll}
            />
            <p className="hint">用于 autoLearn 自动学习：自动从润色前后文本里抽出"识别错的短词"加入词库。</p>
            <div className="actions">
              <button className="secondary" onClick={restoreCorrection}><RotateCcw size={16} />恢复默认</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function VocabularyPage(props: { config: Config; update: (m: (c: Config) => Config) => void }) {
  const [term, setTerm] = useState("");

  function updateAndSave(mutator: (c: Config) => Config) {
    props.update(mutator);
    const next = mutator(props.config);
    void window.aiVoiceInput.saveConfig(next);
  }

  function add() {
    const t = term.trim();
    if (!t) return;
    const next: Config = {
      ...props.config,
      vocabulary: [
        ...props.config.vocabulary,
        { id: crypto.randomUUID(), term: t, enabled: true, source: "manual", createdAt: Date.now(), hitCount: 0 }
      ]
    };
    props.update(() => next);
    void window.aiVoiceInput.saveConfig(next);
    setTerm("");
  }
  return (
    <section className="panel">
      <div className="inlineForm">
        <input placeholder="词条（如 适趣、Mavis）" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <button className="primary compact" onClick={add}><Plus size={16} />添加</button>
      </div>
      <label className="toggle"><input type="checkbox" checked={props.config.autoLearn} onChange={(e) => updateAndSave((c) => ({ ...c, autoLearn: e.target.checked }))} /> 自动学习</label>
      <p className="hint">添加的词条会在润色时被优先使用，匹配同义/近义/同音的其他写法。</p>
      <div className="list">
        {props.config.vocabulary.map((item) => (
          <div className="row" key={item.id}>
            <div>
              <strong>{item.term}</strong>
              <span className="meta">
                {item.source === "correction" ? "自动学习" : "手动添加"}
                {typeof item.hitCount === "number" && item.hitCount > 0 ? ` · 已用 ${item.hitCount} 次` : ""}
              </span>
            </div>
            <div className="rowActions">
              <label className="switch"><input type="checkbox" checked={item.enabled} onChange={(e) => updateAndSave((c) => ({ ...c, vocabulary: c.vocabulary.map((v) => v.id === item.id ? { ...v, enabled: e.target.checked } : v) }))} /></label>
              <button className="icon" onClick={() => updateAndSave((c) => ({ ...c, vocabulary: c.vocabulary.filter((v) => v.id !== item.id) }))}><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PermissionsPage(props: { permissions: PermissionState | null; refresh: () => Promise<void> }) {
  const rows = [
    ["microphone", "麦克风权限", "用于录制语音"],
    ["accessibility", "输入控制权限", "用于尝试自动填入当前输入位置"],
    ["notifications", "通知权限", "用于问答提醒和失败提醒"],
    ["background", "后台运行", "用于保持托盘常驻和快捷键可用"]
  ] as const;
  return (
    <section className="panel">
      {rows.map(([key, title, desc]) => {
        const value = props.permissions?.[key] ?? "unknown";
        return (
          <div className="row" key={key}>
            <div>
              <strong>{title}</strong>
              <span>{desc}</span>
            </div>
            <div className="permissionActions">
              <span className={`perm ${value === "granted" ? "ok" : "warn"}`}>{value === "granted" ? "已授权" : value}</span>
              {key === "microphone" && <button className="secondary" onClick={() => window.aiVoiceInput.requestMicrophone().then(props.refresh)}>请求授权</button>}
              {key !== "background" && <button className="secondary" onClick={() => window.aiVoiceInput.openPermissionSettings(key)}>打开设置</button>}
            </div>
          </div>
        );
      })}
      <button className="primary compact" onClick={props.refresh}><RefreshCw size={16} />重新检测</button>
    </section>
  );
}

function Input(props: { label: string; value: string; onChange: (value: string) => void; type?: string; onBlur?: () => void }) {
  return (
    <>
      <label>{props.label}</label>
      <input type={props.type ?? "text"} value={props.value} onChange={(event) => props.onChange(event.target.value)} onBlur={props.onBlur} />
    </>
  );
}

function Select(props: { value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>{props.children}</select>;
}

createRoot(document.getElementById("root")!).render(<App />);
