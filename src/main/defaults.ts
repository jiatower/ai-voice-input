export type AppStatus =
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "generating"
  | "answering"
  | "needs_attention";

export type ShortcutConfig = {
  dictation: string;
  question: string;
  vocabulary: string;
};

export type ModelConfig = {
  provider: "none" | "deepseek" | "glm" | "custom";
  baseUrl: string;
  path: string;
  model: string;
  apiKey: string;
  temperature: number;
};

export type SpeechConfig = {
  language: "auto" | "zh" | "en";
  mode: "local" | "cloud";
  priority: "speed" | "accuracy";
  advancedOpen: boolean;
  localEnginePath: string;
};

export type IflytekConfig = {
  appId: string;
  apiKey: string;
  apiSecret: string;
};

export type PromptConfig = {
  polish: string;
  qa: string;
};

export type PromptProfile = {
  id: string;
  name: string;
  prompts: PromptConfig;
};

export type VocabularyEntry = {
  id: string;
  term: string;
  aliases: string;
  enabled: boolean;
  source?: "manual" | "correction";
};

export type AppConfig = {
  shortcuts: ShortcutConfig;
  model: ModelConfig;
  speech: SpeechConfig;
  iflytek: IflytekConfig;
  prompts: PromptConfig;
  correctionPrompt: string;
  promptProfiles: PromptProfile[];
  activePromptProfileId: string;
  vocabulary: VocabularyEntry[];
  autoLearn: boolean;
  reviewBeforePaste: boolean;
  autoDetectStyle: boolean;
  showDockIcon: boolean;
  saveHistory: boolean;
};

/**
 * 硬约束前缀：所有润色场景的默认 system prompt 都会拼上这段。
 * 作用是防止 LLM 把"待整理的转写文本"当成"用户提出的问题"来回答。
 *
 * 用户自定义的 prompt 不会被这段覆盖——只在默认 profile 上拼接。
 */
export const POLISH_GUARD_PREFIX = `【任务定义】
你正在处理一段用户通过语音实时转写出来的文本草稿。这不是用户向你提出的问题，也不是需要你回应的话题。
用户说这段话的目的是让软件把它整理好后，自动填回到他正在打字的位置（例如聊天框、文档、代码编辑器）。
你的工作对象是"要被整理的原材料"，不是"要被回答的输入"。

【绝对禁止】
- 不要回答、解释、评论、总结、翻译、引申转写文本中的内容。
- 不要输出"这段话的意思是..."、"总结如下..."、"以下是答案..."之类的元描述。
- 不要把转写文本当成问题来回应，哪怕它以问号结尾、带"是不是"、"对吧"等口吻。
- 不要补充原文没有的信息、例子或建议。
- 不要使用 Markdown 标题、列表、加粗、引用块等富文本结构，除非原文本身就是这种结构。

【允许的操作】
- 纠正识别错误的字词（结合上下文和词库）。
- 删除重复、口头禅（嗯、啊、那个、这个、就是说）。
- 补全缺失的标点。
- 调整语序让句子通顺（仅在不改变原意时）。

【输出格式】
- 严格只输出整理后的最终文本本身。
- 任何前后缀、解释、代码块标记、Markdown 装饰都属于错误输出。
- 如果转写文本本身就是空的或没有意义，输出空字符串。

`;

/**
 * 包装用户自定义的润色提示词，注入硬约束前缀。
 * 默认出厂 prompt 会被加上前缀；用户后续在 UI 里改过的 prompt 也走这里统一处理。
 */
export function withPolishGuard(userPrompt: string): string {
  return POLISH_GUARD_PREFIX + userPrompt;
}

export const defaultPrompts: PromptConfig = {
  polish: withPolishGuard(
    "你是语音输入文本整理助手。请在保持原意的前提下，纠正错别字，删除重复和口头禅，补全标点，保留专有名词。只输出最终可直接使用的文本，不解释处理过程。"
  ),
  qa:
    "你是简洁可靠的语音问答助手。请直接回答用户问题，结构清晰，必要时给出步骤。只输出答案，不解释你如何处理。"
};

export const promptProfiles: PromptProfile[] = [
  {
    id: "standard",
    name: "标准润色",
    prompts: {
      polish: withPolishGuard(
        "你是语音输入文本整理助手。请在保持原意的前提下，纠正错别字，删除重复和口头禅，补全标点，保留专有名词。只输出最终可直接使用的文本，不解释处理过程。"
      ),
      qa: defaultPrompts.qa
    }
  },
  {
    id: "chat",
    name: "口头聊天",
    prompts: {
      polish: withPolishGuard(
        "你是语音输入整理助手，用于微信、IM 等日常聊天场景。请在保持原意的前提下纠正错别字、删除重复和口头禅、补全标点，保留专有名词。语气口语化，可以适当加语气词和表情符号（😄👍🙏等），不要过于书面。只输出最终文本，不解释。"
      ),
      qa: defaultPrompts.qa
    }
  },
  {
    id: "precise",
    name: "高度还原",
    prompts: {
      polish: withPolishGuard(
        "你是语音输入整理助手。核心原则：最大限度保留原文的措辞、语序和语气，只做必要的修正——纠正明显错别字、删除无意义重复、补全缺失的标点。不要润色、不要改写、不要调整语序，哪怕原文不那么流畅。专有名词、数字、英文单词绝对不能改。只输出最终文本，不解释。"
      ),
      qa: defaultPrompts.qa
    }
  },
  {
    id: "formal",
    name: "正式书面",
    prompts: {
      polish: withPolishGuard(
        "你是语音输入整理助手，用于邮件、报告、工作文档等正式场合。在保持原意的前提下，纠正错别字和语法错误，补全标点，将口语化表达转为书面语，确保逻辑通顺、格式规范。保留专有名词、数字和英文术语。只输出最终文本，不解释。"
      ),
      qa: defaultPrompts.qa
    }
  },
  {
    id: "concise",
    name: "精炼概括",
    prompts: {
      polish: withPolishGuard(
        "你是语音输入整理助手。请将输入内容提炼为简洁要点，去除冗余和口语化的铺垫，保留核心信息和关键结论。输出应简短清晰，适合用作笔记或摘要。保留专有名词、数字和英文术语。只输出最终文本，不解释。"
      ),
      qa: defaultPrompts.qa
    }
  },
  {
    id: "agent",
    name: "AI 指令",
    prompts: {
      polish: withPolishGuard(
        "你是语音输入整理助手，用于将口述需求转化为给 AI 的指令。请做到：1) 去掉口头禅、重复和无关铺垫；2) 纠正识别错误的词（尤其技术名词、文件名、参数名）；3) 将碎片化的口述组织成清晰的指令或需求描述，补全隐含上下文；4) 保留所有技术细节、代码片段、数字和专有名词不能改错。输出应是可直接发给 AI 工具的完整指令。只输出最终文本，不解释。"
      ),
      qa: defaultPrompts.qa
    }
  }
];

export const defaultPromptProfile: PromptProfile = promptProfiles[0];

/**
 * 自动匹配 App → 提示词 profile 的映射表。
 *
 * 维护规则：
 * - key 用 macOS 上 frontmost app 的 name（中文名也加，兼容本地化）。
 * - value 必须是 promptProfiles 里已有的 profile id。
 * - 不在表里的 App 会 fallback 到 "standard"。
 */
export const appStyleMap: Record<string, string> = {
  // ── AI 编程助手 / 智能体（agent 风格）──
  "Visual Studio Code": "agent",
  "Code": "agent",
  "Cursor": "agent",
  "Cursor AI": "agent",
  "Codex": "agent",
  "Claude Code": "agent",
  "OpenCode": "agent",
  "Aider": "agent",
  "Continue": "agent",
  "Cline": "agent",
  "Roo Code": "agent",
  "GitHub Copilot": "agent",
  "Zed": "agent",
  "Trae": "agent",
  "Mavis": "agent",
  "Mavis Desktop": "agent",
  "Mavis Code": "agent",
  "Mavis CLI": "agent",
  "Mavis Workspace": "agent",
  "Mavis 桌面": "agent",
  "Mavis IDE": "agent",
  "Windsurf": "agent",
  "Tabnine": "agent",

  // ── IDE / 编辑器（agent 风格）──
  "Xcode": "agent",
  "IntelliJ IDEA": "agent",
  "WebStorm": "agent",
  "PyCharm": "agent",
  "GoLand": "agent",
  "CLion": "agent",
  "RubyMine": "agent",
  "PhpStorm": "agent",
  "Rider": "agent",
  "DataGrip": "agent",
  "AppCode": "agent",
  "Android Studio": "agent",
  "Sublime Text": "agent",
  "MacVim": "agent",
  "Neovide": "agent",
  "Nova": "agent",
  "BBEdit": "agent",

  // ── 终端（agent 风格）──
  "Terminal": "agent",
  "终端": "agent",
  "iTerm2": "agent",
  "Warp": "agent",
  "Hyper": "agent",
  "Alacritty": "agent",
  "Kitty": "agent",
  "WezTerm": "agent",
  "Tabby": "agent",

  // ── 浏览器（standard 风格，网页输入框五花八门，用通用）──
  "Chrome": "standard",
  "Google Chrome": "standard",
  "Safari": "standard",
  "Firefox": "standard",
  "Arc": "standard",
  "Microsoft Edge": "standard",
  "Edge": "standard",
  "Brave Browser": "standard",
  "Brave": "standard",
  "Dia": "standard",
  "Opera": "standard",
  "Vivaldi": "standard",
  "Chromium": "standard",

  // ── 中文 IM / 协作（chat 风格）──
  "WeChat": "chat",
  "Weixin": "chat",
  "微信": "chat",
  "QQ": "chat",
  "TIM": "chat",
  "企业微信": "chat",
  "WeCom": "chat",
  "DingTalk": "chat",
  "钉钉": "chat",
  "飞书": "chat",
  "Feishu": "chat",
  "Lark": "chat",
  "千牛": "chat",
  "旺旺": "chat",
  "豆包": "chat",

  // ── 国际 IM（chat 风格）──
  "Microsoft Teams": "chat",
  "Slack": "chat",
  "Discord": "chat",
  "Telegram": "chat",
  "Messages": "chat",
  "信息": "chat",
  "WhatsApp": "chat",
  "Signal": "chat",
  "Line": "chat",
  "Messenger": "chat",
  "Skype": "chat",
  "Zoom": "chat",

  // ── 邮件（formal 风格）──
  "Mail": "formal",
  "邮件": "formal",
  "Microsoft Outlook": "formal",
  "Outlook": "formal",
  "Spark": "formal",
  "Airmail": "formal",
  "Foxmail": "formal",
  "网易邮箱大师": "formal",
  "NeteaseMail": "formal",

  // ── 文档 / 办公（formal 风格）──
  "Microsoft Word": "formal",
  "Pages": "formal",
  "WPS Office": "formal",
  "WPS": "formal",
  "Google Docs": "formal",
  "腾讯文档": "formal",
  "Tencent Docs": "formal",
  "飞书文档": "formal",
  "Lark Docs": "formal",
  "语雀": "formal",
  "Yuque": "formal",
  "石墨文档": "formal",
  "Shimo": "formal",
  "Quip": "formal",
  "LibreOffice Writer": "formal",

  // ── 表格 / 演示（formal 风格）──
  "Microsoft Excel": "formal",
  "Numbers": "formal",
  "Microsoft PowerPoint": "formal",
  "Keynote": "formal",
  "Google Sheets": "formal",
  "Google Slides": "formal",
  "LibreOffice Calc": "formal",
  "LibreOffice Impress": "formal",

  // ── 笔记 / 知识库（concise 风格）──
  "Notes": "concise",
  "备忘录": "concise",
  "Notion": "concise",
  "Obsidian": "concise",
  "Logseq": "concise",
  "思源笔记": "concise",
  "SiYuan": "concise",
  "Typora": "concise",
  "Bear": "concise",
  "Day One": "concise",
  "Drafts": "concise",
  "Evernote": "concise",
  "印象笔记": "concise",
  "Yinxiang": "concise",
  "OneNote": "concise",
  "Microsoft OneNote": "concise",
  "Craft": "concise",
  "GoodNotes": "concise",
  "Notability": "concise",
  "MarginNote": "concise",
  "Roam Research": "concise",

  // ── 设计 / 创作（formal 风格，默认走规范排版）──
  "Figma": "formal",
  "Sketch": "formal",
  "Adobe XD": "formal",
  "Photoshop": "formal",
  "Adobe Photoshop": "formal",
  "Illustrator": "formal",
  "Adobe Illustrator": "formal",
  "InDesign": "formal",
  "Adobe InDesign": "formal",
  "Premiere Pro": "formal",
  "Adobe Premiere Pro": "formal",
  "Final Cut Pro": "formal",
  "DaVinci Resolve": "formal",
  "After Effects": "formal",
  "Adobe After Effects": "formal",
  "Lightroom": "formal",
  "Adobe Lightroom": "formal",
  "Canva": "formal",
  "即时设计": "formal",
  "MasterGo": "formal",
  "Pixso": "formal",

  // ── 音乐 / 视频 / 娱乐（chat 风格，口语化更自然）──
  "Spotify": "chat",
  "网易云音乐": "chat",
  "NetEaseMusic": "chat",
  "QQ音乐": "chat",
  "QQ Music": "chat",
  "Apple Music": "chat",
  "Music": "chat",
  "VLC": "chat",
  "IINA": "chat",
  "IINA Pro": "chat",
  "Infuse": "chat",

  // ── 终端工具 / 系统类（agent 风格）──
  "Activity Monitor": "agent",
  "活动监视器": "agent",
  "Console": "agent",
  "系统偏好设置": "agent",
  "System Preferences": "agent",
  "System Settings": "agent",
  "设置": "agent",
};

export const modelPresets: Record<string, Partial<ModelConfig>> = {
  deepseek: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    path: "/chat/completions",
    model: "deepseek-chat",
    temperature: 0.2
  },
  glm: {
    provider: "glm",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    path: "/chat/completions",
    model: "glm-4-plus",
    temperature: 0.2
  }
};

export const defaultConfig: AppConfig = {
  shortcuts: {
    dictation: "Control+Shift+Space",
    question: "Control+Shift+.",
    vocabulary: "Control+Shift+V"
  },
  model: {
    provider: "none",
    baseUrl: "",
    path: "/chat/completions",
    model: "",
    apiKey: "",
    temperature: 0.2
  },
  speech: {
    language: "auto",
    mode: "local",
    priority: "speed",
    advancedOpen: false,
    localEnginePath: ""
  },
  iflytek: {
    appId: "1c19f36f",
    apiKey: "a941b74ddf278f9e12129c6add3cbb67",
    apiSecret: "ZTlhOTEzMWQyNjRmMTBhNGY4NjRiZjc1"
  },
  prompts: defaultPrompts,
  correctionPrompt: "你是语音识别纠错助手。对比用户提供的两段文本，找出所有被修正的词汇或短语。只输出 JSON 数组，不要任何解释。",
  promptProfiles: promptProfiles,
  activePromptProfileId: promptProfiles[0].id,
  vocabulary: [
    { id: "voc-1", term: ".env", aliases: "", enabled: true, source: "manual" },
    { id: "voc-2", term: "适趣", aliases: "", enabled: true, source: "manual" },
    { id: "voc-3", term: "FC", aliases: "", enabled: true, source: "manual" },
    { id: "voc-4", term: "gen_messages", aliases: "", enabled: true, source: "manual" },
    { id: "voc-5", term: "有泳道1", aliases: "", enabled: true, source: "manual" },
    { id: "voc-6", term: "private_messages", aliases: "", enabled: true, source: "manual" },
    { id: "voc-7", term: "gen_class_sop", aliases: "", enabled: true, source: "manual" },
    { id: "voc-8", term: "message_list", aliases: "", enabled: true, source: "manual" },
    { id: "voc-9", term: "HTTPS", aliases: "", enabled: true, source: "manual" },
    { id: "voc-10", term: "mock", aliases: "Mock", enabled: true, source: "manual" },
    { id: "voc-11", term: "测销", aliases: "", enabled: true, source: "manual" },
    { id: "voc-12", term: "no_effect", aliases: "", enabled: true, source: "manual" },
    { id: "voc-13", term: "SAE", aliases: "", enabled: true, source: "manual" },
    { id: "voc-14", term: "MR", aliases: "", enabled: true, source: "manual" },
    { id: "voc-15", term: "json", aliases: "", enabled: true, source: "manual" },
    { id: "voc-16", term: "debug", aliases: "", enabled: true, source: "manual" },
    { id: "voc-17", term: "Codex", aliases: "", enabled: true, source: "manual" },
    { id: "voc-18", term: "Mavis", aliases: "", enabled: true, source: "manual" },
    { id: "voc-19", term: "Trae", aliases: "", enabled: true, source: "manual" },
    { id: "voc-20", term: "OpenCode", aliases: "", enabled: true, source: "manual" },
    { id: "voc-21", term: "coze", aliases: "", enabled: true, source: "manual" },
  ],
  autoLearn: true,
  reviewBeforePaste: false,
  autoDetectStyle: true,
  showDockIcon: true,
  saveHistory: false
};
