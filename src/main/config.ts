import { app } from "electron";
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppConfig, defaultConfig, promptProfiles, PromptProfile, withPolishGuard } from "./defaults";

const configPath = () => join(app.getPath("userData"), "config.json");

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
    vocabulary: input.vocabulary ?? defaultConfig.vocabulary
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
      // 老用户升级时，他们的 polish prompt 可能是旧版（没有硬约束前缀）。
      // 统一包一层，确保防"答非所问"的兜底对所有用户生效。
      polish: withPolishGuard(profile.prompts?.polish || defaultConfig.prompts.polish)
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
