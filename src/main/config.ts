import { app } from "electron";
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AppConfig,
  defaultConfig,
  defaultPolishPrompt,
  defaultQaPrompt,
  defaultCorrectionPrompt,
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

function mergeConfig(input: Partial<AppConfig> & Record<string, unknown>): AppConfig {
  const shortcuts = { ...defaultConfig.shortcuts, ...input.shortcuts };
  if (process.platform === "darwin") {
    for (const key of Object.keys(shortcuts) as Array<keyof typeof shortcuts>) {
      shortcuts[key] = shortcuts[key].replace(/^CommandOrControl\+/i, "Control+");
    }
  }

  // 老用户磁盘上可能还存着 prompts / promptProfiles / activePromptProfileId / autoDetectStyle
  // 这些字段在新的 AppConfig 里已经不存在了；loadConfig 阶段直接忽略，只在新字段缺失时回退到默认。
  // 老 polish prompt 可能是"硬约束 + 风格"拼接形式；用户首次启动新版本后会被默认替换，
  // 用户在 UI 里重新编辑即可。
  const polishPrompt = typeof input.polishPrompt === "string" && input.polishPrompt
    ? input.polishPrompt
    : defaultPolishPrompt;
  const qaPrompt = typeof input.qaPrompt === "string" && input.qaPrompt
    ? input.qaPrompt
    : defaultQaPrompt;
  const correctionPrompt = typeof input.correctionPrompt === "string" && input.correctionPrompt
    ? input.correctionPrompt
    : defaultCorrectionPrompt;

  return {
    ...defaultConfig,
    ...input,
    shortcuts,
    model: { ...defaultConfig.model, ...input.model },
    speech: { ...defaultConfig.speech, ...input.speech },
    polishPrompt,
    qaPrompt,
    correctionPrompt,
    vocabulary: migrateVocabulary(input.vocabulary)
  };
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
