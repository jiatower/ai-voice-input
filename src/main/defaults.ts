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

export const defaultPrompts: PromptConfig = {
  polish:
    "你是语音输入文本整理助手。请在保持原意的前提下，纠正错别字，删除重复和口头禅，补全标点，保留专有名词。只输出最终可直接使用的文本，不解释处理过程。",
  qa:
    "你是简洁可靠的语音问答助手。请直接回答用户问题，结构清晰，必要时给出步骤。只输出答案，不解释你如何处理。"
};

export const promptProfiles: PromptProfile[] = [
  {
    id: "standard",
    name: "标准润色",
    prompts: {
      polish:
        "你是语音输入文本整理助手。请在保持原意的前提下，纠正错别字，删除重复和口头禅，补全标点，保留专有名词。只输出最终可直接使用的文本，不解释处理过程。",
      qa: defaultPrompts.qa
    }
  },
  {
    id: "chat",
    name: "口头聊天",
    prompts: {
      polish:
        "你是语音输入整理助手，用于微信、IM 等日常聊天场景。请在保持原意的前提下纠正错别字、删除重复和口头禅、补全标点，保留专有名词。语气口语化，可以适当加语气词和表情符号（😄👍🙏等），不要过于书面。只输出最终文本，不解释。",
      qa: defaultPrompts.qa
    }
  },
  {
    id: "precise",
    name: "高度还原",
    prompts: {
      polish:
        "你是语音输入整理助手。核心原则：最大限度保留原文的措辞、语序和语气，只做必要的修正——纠正明显错别字、删除无意义重复、补全缺失的标点。不要润色、不要改写、不要调整语序，哪怕原文不那么流畅。专有名词、数字、英文单词绝对不能改。只输出最终文本，不解释。",
      qa: defaultPrompts.qa
    }
  },
  {
    id: "formal",
    name: "正式书面",
    prompts: {
      polish:
        "你是语音输入整理助手，用于邮件、报告、工作文档等正式场合。在保持原意的前提下，纠正错别字和语法错误，补全标点，将口语化表达转为书面语，确保逻辑通顺、格式规范。保留专有名词、数字和英文术语。只输出最终文本，不解释。",
      qa: defaultPrompts.qa
    }
  },
  {
    id: "concise",
    name: "精炼概括",
    prompts: {
      polish:
        "你是语音输入整理助手。请将输入内容提炼为简洁要点，去除冗余和口语化的铺垫，保留核心信息和关键结论。输出应简短清晰，适合用作笔记或摘要。保留专有名词、数字和英文术语。只输出最终文本，不解释。",
      qa: defaultPrompts.qa
    }
  },
  {
    id: "agent",
    name: "AI 指令",
    prompts: {
      polish:
        "你是语音输入整理助手，用于将口述需求转化为给 AI 的指令。请做到：1) 去掉口头禅、重复和无关铺垫；2) 纠正识别错误的词（尤其技术名词、文件名、参数名）；3) 将碎片化的口述组织成清晰的指令或需求描述，补全隐含上下文；4) 保留所有技术细节、代码片段、数字和专有名词不能改错。输出应是可直接发给 AI 工具的完整指令。只输出最终文本，不解释。",
      qa: defaultPrompts.qa
    }
  }
];

export const defaultPromptProfile: PromptProfile = promptProfiles[0];

export const appStyleMap: Record<string, string> = {
  "WeChat": "chat",
  "Weixin": "chat",
  "微信": "chat",
  "Microsoft Teams": "chat",
  "Slack": "chat",
  "Discord": "chat",
  "Telegram": "chat",
  "Messages": "chat",
  "信息": "chat",
  "QQ": "chat",
  "DingTalk": "chat",
  "钉钉": "chat",
  "飞书": "chat",
  "Feishu": "chat",
  "Lark": "chat",
  "Mail": "formal",
  "邮件": "formal",
  "Microsoft Outlook": "formal",
  "Microsoft Word": "formal",
  "Pages": "formal",
  "Notes": "concise",
  "备忘录": "concise",
  "Notion": "concise",
  "Obsidian": "concise",
  "Visual Studio Code": "agent",
  "Code": "agent",
  "Terminal": "agent",
  "终端": "agent",
  "iTerm2": "agent",
  "Warp": "agent",
  "Cursor": "agent",
  "Cursor AI": "agent",
  "GitHub Copilot": "agent",
  "Xcode": "agent",
  "IntelliJ IDEA": "agent",
  "WebStorm": "agent",
  "Codex": "agent",
  "OpenCode": "agent",
  "Marvis": "agent",
  "Trae": "agent",
  "Minimax code": "agent",
  "Chrome": "standard",
  "豆包": "chat",
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
    { id: "voc-18", term: "Marvis", aliases: "", enabled: true, source: "manual" },
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
