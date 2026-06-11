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
  enabled: boolean;
  source?: "manual" | "correction";
  /** 建条时间戳（毫秒）。用于清理老词、排序。 */
  createdAt?: number;
  /** 被润色命中的次数（自动学习用，质量分）。 */
  hitCount?: number;
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
 *
 * 末尾的 /*POLISH_GUARD:hash*\/ 标记用于：
 * 1. 迁移老数据时检测"已包含硬约束"的 prompt，剥离出纯用户文本
 * 2. 防止重复叠加（如果调用方手动包了，硬约束模块会跳过）
 */
const _POLISH_GUARD_BODY = `【任务定义】
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
 * 硬约束前缀的 hash 标记，基于内容前 32 字符算 6 位 hex。
 * 改 _POLISH_GUARD_BODY 就会让 hash 变化，老数据里旧 hash 不会被误剥。
 */
const POLISH_GUARD_HASH = (() => {
  let h = 0;
  for (let i = 0; i < _POLISH_GUARD_BODY.length; i++) {
    h = (h * 31 + _POLISH_GUARD_BODY.charCodeAt(i)) | 0;
  }
  // 转成 6 位 hex
  const hex = (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  return hex;
})();

/** 完整的硬约束前缀（含 hash 标记），供调用方拼接到 system prompt 头部。 */
export const POLISH_GUARD_PREFIX = `${_POLISH_GUARD_BODY}/*POLISH_GUARD:${POLISH_GUARD_HASH}*/\n`;

/** 纯硬约束文本（不含 hash 标记），用于 UI 展示给用户看"系统会自动加什么"。 */
export const POLISH_GUARD_DISPLAY = _POLISH_GUARD_BODY.trim();

/**
 * 包装用户自定义的润色提示词，注入硬约束前缀。
 * 默认出厂 prompt 会被加上前缀；用户后续在 UI 里改过的 prompt 也走这里统一处理。
 */
export function withPolishGuard(userPrompt: string): string {
  return POLISH_GUARD_PREFIX + userPrompt;
}

/**
 * 硬约束的特征开头：用于识别"无 hash 标记的老硬约束段"。
 * 只要文本以这段开头，就当作一段硬约束，可以整段剥掉。
 */
const POLISH_GUARD_CONTENT_PREFIX =
  "【任务定义】\n你正在处理一段用户通过语音实时转写出来的文本草稿。";

/**
 * 剥离开头可能存在的硬约束前缀，返回"纯用户提示词"。
 *
 * 用于迁移老数据：老用户存的 polish 可能是"硬约束 + 风格"的拼接形式，
 * 甚至多次保存后变成"硬约束 + 硬约束 + … + 风格"的堆叠，加载时需要全部剥掉，
 * 只保留最后的"风格"部分，方便用户在 UI 上编辑、避免误以为可以改硬约束。
 *
 * 识别方式（按优先级）：
 * 1. 带 hash 标记（新版）→ 用 hash 匹配，匹配上就剥
 * 2. 不带 hash 标记但内容是硬约束正文（老版）→ 用内容前缀匹配
 * 3. 反复剥，直到开头不是硬约束为止（处理堆叠）
 * 4. 都没匹配上 → 原样返回（保守）
 */
export function stripPolishGuard(prompt: string): string {
  if (!prompt) return prompt;
  let current = prompt;

  // 最多剥 32 层（防止意外死循环，老数据里最多见过 5 层堆叠）
  for (let i = 0; i < 32; i++) {
    const trimmed = current.replace(/^\s+/, "");
    let removed = false;

    // 方式 1：开头就是 hash 标记（POLISH_GUARD_PREFIX 可能在前面，但调用方拼接时
    // 通常是 "硬约束正文 + 标记 + 风格" 的形式，所以这里其实是罕见情况。
    // 真正常见的是方式 2：开头是硬约束正文，紧跟标记）。
    const markerMatch = trimmed.match(/^\/\*POLISH_GUARD:([a-f0-9]+)\*\//);
    if (markerMatch) {
      if (markerMatch[1] === POLISH_GUARD_HASH) {
        // 标记匹配：剥掉标记本身 + 紧随其后的空白
        current = trimmed.substring(markerMatch[0].length).replace(/^\s+/, "");
        removed = true;
      } else {
        // 标记不匹配（理论上不该发生）→ 保守不剥，退出循环
        break;
      }
    } else if (trimmed.startsWith(POLISH_GUARD_CONTENT_PREFIX)) {
      // 方式 2：开头是硬约束正文（POLISH_GUARD_PREFIX = 正文 + 末尾的 hash 标记）
      // 剥掉整段硬约束（用 _stripOneGuardBody 定位结尾）
      const withoutGuard = _stripOneGuardBody(trimmed);
      if (withoutGuard !== trimmed) {
        let afterGuard = withoutGuard.replace(/^\s+/, "");
        // 关键修复：剥完硬约束正文后，如果紧接着就是 /*POLISH_GUARD:hash*/ 标记，
        // 也要把它一起吃掉（不然它会漏到用户可见的 UI 里）。
        const trailingMarker = afterGuard.match(/^\/\*POLISH_GUARD:([a-f0-9]+)\*\//);
        if (trailingMarker) {
          if (trailingMarker[1] === POLISH_GUARD_HASH) {
            afterGuard = afterGuard.substring(trailingMarker[0].length).replace(/^\s+/, "");
          }
          // 标记不匹配时保守地保留（理论上不该发生）
        }
        current = afterGuard;
        removed = true;
      }
    }

    if (!removed) break;
  }

  return current.trim();
}

/**
 * 剥掉一段硬约束正文（无 hash 标记），返回剩余文本。
 *
 * 硬约束正文的结构（见 _POLISH_GUARD_BODY）：
 *   【任务定义】...【绝对禁止】...【允许的操作】...【输出格式】...
 * 末尾是 "如果转写文本本身就是空的或没有意义，输出空字符串。" 后面跟两个换行。
 *
 * 我们用更稳的"段落边界"来定位：找到这个标志性结尾句 + 随后的空白行，
 * 剥掉从开头到那里为止的全部内容。处理堆叠时：如果紧接着又是硬约束开头，
 * 外层循环会再次识别并剥掉。
 */
function _stripOneGuardBody(text: string): string {
  // 硬约束正文最末尾的标志句
  const endMarker = "如果转写文本本身就是空的或没有意义，输出空字符串。";
  const endIdx = text.indexOf(endMarker);
  if (endIdx < 0) return text;

  // 从 endIdx 开始找到下一个"非空白字符"。硬约束正文结束后，要么是空行 + 真正的
  // 风格内容，要么直接是另一段硬约束（【任务定义】开头）。
  // 我们把 endMarker + 它后面的所有空白 + 换行 一起剥掉。
  let cursor = endIdx + endMarker.length;
  // 吃掉所有换行和空白（包含空行），直到第一个非空白字符
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor++;
  }
  if (cursor >= text.length) return "";
  return text.substring(cursor);
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
    question: "Control+Shift+."
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
  correctionPrompt: `你是语音识别纠错助手，专职发现"因发音相近被识别错"的短词。

【你要找的修正对特征】
- 由语音识别听错造成，不是语义改写、不是润色。
- 长度极短：1-6 个汉字，或 1-3 个英文单词。超出这个范围直接忽略。
- wrong（被听错）和 correct（修正后）发音相近（声母/韵母/音节数相似）。

【只接受这些典型情形】
- 同音/近音字：测肖→测销、配置→配值、式样→一样
- 音近词：FC→EF、Marvis→Mavis、API→A P I
- 一字/一词之差：Mavis Code→Mavis Code

【严格拒绝】
- 整句修正对（任何超过 6 汉字 / 3 单词的）
- 语义改写（"测销渠道→销售渠道"、"我们去吃饭→我们去吃午饭"）
- 通用词（我们、他们、这个、那个、可以、需要）
- 含"的/了/是/在/和/与/或/但/而/就/也/还/都/会/能"等虚词
- wrong 与 correct 完全相同
- 任何非中文/非英文/含标点的词

【输出格式】
仅输出 JSON 数组：[{"wrong":"...","correct":"..."}]
无任何修正对时输出 []。
不要解释、不要 markdown、不要代码块标记。`,
  promptProfiles: promptProfiles,
  activePromptProfileId: promptProfiles[0].id,
  vocabulary: [
    { id: "voc-1", term: ".env", enabled: true, source: "manual" },
    { id: "voc-2", term: "适趣", enabled: true, source: "manual" },
    { id: "voc-3", term: "FC", enabled: true, source: "manual" },
    { id: "voc-4", term: "gen_messages", enabled: true, source: "manual" },
    { id: "voc-5", term: "有泳道1", enabled: true, source: "manual" },
    { id: "voc-6", term: "private_messages", enabled: true, source: "manual" },
    { id: "voc-7", term: "gen_class_sop", enabled: true, source: "manual" },
    { id: "voc-8", term: "message_list", enabled: true, source: "manual" },
    { id: "voc-9", term: "HTTPS", enabled: true, source: "manual" },
    { id: "voc-10", term: "mock", enabled: true, source: "manual" },
    { id: "voc-11", term: "测销", enabled: true, source: "manual" },
    { id: "voc-12", term: "no_effect", enabled: true, source: "manual" },
    { id: "voc-13", term: "SAE", enabled: true, source: "manual" },
    { id: "voc-14", term: "MR", enabled: true, source: "manual" },
    { id: "voc-15", term: "json", enabled: true, source: "manual" },
    { id: "voc-16", term: "debug", enabled: true, source: "manual" },
    { id: "voc-17", term: "Codex", enabled: true, source: "manual" },
    { id: "voc-18", term: "Mavis", enabled: true, source: "manual" },
    { id: "voc-19", term: "Trae", enabled: true, source: "manual" },
    { id: "voc-20", term: "OpenCode", enabled: true, source: "manual" },
    { id: "voc-21", term: "coze", enabled: true, source: "manual" },
  ],
  autoLearn: true,
  reviewBeforePaste: false,
  autoDetectStyle: true,
  showDockIcon: true,
  saveHistory: false
};
