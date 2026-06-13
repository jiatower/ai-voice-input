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
  clipboardPicker: string;
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
  /** 润色提示词：发给 LLM 的完整 system prompt，textarea 里编辑什么就用什么 */
  polishPrompt: string;
  /** 问答提示词：语音问答模式的 system prompt */
  qaPrompt: string;
  /** 纠错提示词：autoLearn 用，识别"原文 vs 修正后"里的错字 */
  correctionPrompt: string;
  vocabulary: VocabularyEntry[];
  autoLearn: boolean;
  reviewBeforePaste: boolean;
  showDockIcon: boolean;
  saveHistory: boolean;
};

/**
 * 默认润色提示词 —— 用户可以直接编辑，没有任何"系统硬约束"前置。
 * 想要严格控制 LLM 行为时，自己写规则就行（提示词工程属于你）。
 */
export const defaultPolishPrompt = `你是语音输入文本整理助手。请在保持原意的前提下，纠正错别字，删除重复和口头禅（嗯、呃、啊、那个、这个、就是说、对吧、然后呢、其实、反正、就是、可能、我觉得、你知道的、OK 的话），补全标点，保留专有名词、数字、英文单词。

核心原则：保守转写，保留原意。
- 只纠正 ASR 误识别的字词，不做语义润色
- 不要重组句子结构、不要补全隐含逻辑、不要把不通顺的句子"写通顺"
- 不要补充原文没有的信息、例子或建议
- 用户说了什么就是什么，碎片就保留碎片

只输出整理后的最终文本本身，不要任何前后缀、解释或 Markdown 装饰。`;

/**
 * 默认问答提示词 —— 语音问答模式（按 Ctrl+W）用。
 */
export const defaultQaPrompt = `你是简洁可靠的语音问答助手。请直接回答用户问题，结构清晰，必要时给出步骤。只输出答案，不解释你如何处理。`;

/**
 * 默认纠错提示词 —— autoLearn 自动学习路径里，AI 用这个从"原文 vs 修正后"里抽"被误识别的词对"。
 */
export const defaultCorrectionPrompt = `你是语音识别纠错助手，专职发现"因发音相近被识别错"的短词。

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
不要解释、不要 markdown、不要代码块标记。`;

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
    dictation: "Control+Q",
    question: "Control+W",
    clipboardPicker: "Command+Shift+V"
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
    appId: "",
    apiKey: "",
    apiSecret: ""
  },
  polishPrompt: defaultPolishPrompt,
  qaPrompt: defaultQaPrompt,
  correctionPrompt: defaultCorrectionPrompt,
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
    { id: "voc-21", term: "coze", enabled: true, source: "manual" }
  ],
  autoLearn: true,
  reviewBeforePaste: false,
  showDockIcon: true,
  saveHistory: false
};
