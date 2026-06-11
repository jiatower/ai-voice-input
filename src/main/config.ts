import { app } from "electron";
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AppConfig,
  defaultConfig,
  promptProfiles,
  PromptProfile,
  stripPolishGuard,
  VocabularyEntry
} from "./defaults";

const configPath = () => join(app.getPath("userData"), "config.json");

/**
 * 词库迁移：老格式 { term, aliases: "a,b,c" } → 新格式 { term }。
 * 用户已明确要求：老 alias 直接丢弃，不作为独立 term 保留。
 *
 * 同时补齐 createdAt / hitCount 字段。
 */
function migrateVocabulary(input: unknown): VocabularyEntry[] {
  if (!Array.isArray(input)) return defaultConfig.vocabulary;
  const now = Date.now();
  const seen = new Set<string>();
  const result: VocabularyEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Partial<VocabularyEntry> & { aliases?: unknown };
    const term = typeof entry.term === "string" ? entry.term.trim() : "";
    if (!term || seen.has(term)) continue;
    seen.add(term);
    result.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `voc-${now}-${result.length}`,
      term,
      enabled: entry.enabled !== false,
      source: entry.source === "correction" ? "correction" : "manual",
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : now,
      hitCount: typeof entry.hitCount === "number" ? entry.hitCount : 0
    });
  }
  return result;
}

function mergeConfig(input: Partial<AppConfig>): AppConfig {
  const shortcuts = { ...defaultConfig.shortcuts, ...input.shortcuts };
  if (process.platform === "darwin") {
    for (const key of Object.keys(shortcuts) as Array<keyof typeof shortcuts>) {
      shortcuts[key] = shortcuts[key].replace(/^CommandOrControl\+/i, "Control+");
    }
  }

  const legacyPrompts = { ...defaultConfig.prompts, ...input.prompts };
  const promptProfiles = normalizePromptProfiles(input.promptProfiles, legacyPrompts);
  const activePromptProfileId = promptProfiles.some((profile) => profile.id === input.activePromptProfileId)
    ? input.activePromptProfileId!
    : promptProfiles[0].id;
  const activeProfile = promptProfiles.find((profile) => profile.id === activePromptProfileId) ?? promptProfiles[0];

  return {
    ...defaultConfig,
    ...input,
    shortcuts,
    model: { ...defaultConfig.model, ...input.model },
    speech: { ...defaultConfig.speech, ...input.speech },
    prompts: activeProfile.prompts,
    promptProfiles,
    activePromptProfileId,
    vocabulary: migrateVocabulary(input.vocabulary)
  };
}

function normalizePromptProfiles(input: PromptProfile[] | undefined, _fallback: AppConfig["prompts"]): PromptProfile[] {
  const saved = (Array.isArray(input) && input.length > 0 ? input : []).map((p) => ({
    id: p.id,
    name: p.name?.trim() || "",
    prompts: { ...defaultConfig.prompts, ...p.prompts }
  }));

  const builtinIds = new Set(promptProfiles.map((p) => p.id));
  const savedIds = new Set(saved.filter((p) => p.id).map((p) => p.id));

  // 补上缺失的内置预设（不影响用户手动删除的，通过判断 savedIds 里是否有同 id 的）
  const result = [...saved];
  for (const builtin of promptProfiles) {
    if (!savedIds.has(builtin.id)) {
      result.push({ ...builtin, prompts: { ...builtin.prompts } });
    }
  }

  return result.map((profile, index) => ({
    id: profile.id || `prompt-${index + 1}`,
    name: profile.name?.trim() || `提示词 ${index + 1}`,
    prompts: {
      ...defaultConfig.prompts,
      ...profile.prompts,
      // 老用户升级时，他们的 polish prompt 可能是"硬约束 + 风格"的拼接形式。
      // 剥离开头可能存在的硬约束前缀（基于 hash 标记），只保留"风格"部分。
      // 硬约束会在调用 LLM 时由代码显式拼接，不再混入用户可编辑区域。
      polish: stripPolishGuard(profile.prompts?.polish || defaultConfig.prompts.polish)
    }
  }));
}

export function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    return mergeConfig(JSON.parse(raw) as Partial<AppConfig>);
  } catch {
    return defaultConfig;
  }
}

export async function saveConfig(config: AppConfig): Promise<AppConfig> {
  const next = mergeConfig(config);
  mkdirSync(dirname(configPath()), { recursive: true });
  await writeFile(configPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export async function patchConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = loadConfig();
  return saveConfig(mergeConfig({ ...current, ...patch }));
}
