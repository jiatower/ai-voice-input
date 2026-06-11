#!/bin/bash
# 重置 AI Voice Input 的提示词（promptProfiles）为出厂默认。
# 保留其他设置（词库、模型、快捷键、修正历史等）。
# 这次直接 strip 到只剩"风格部分"，不再带 hash 标记。
#
# 用法：bash scripts/reset-prompts.sh

set -e

CONFIG="$HOME/Library/Application Support/ai-voice-input/config.json"
BACKUP="$CONFIG.bak-$(date +%Y%m%d-%H%M)"

if [ ! -f "$CONFIG" ]; then
  echo "❌ 找不到 config.json: $CONFIG"
  exit 1
fi

# 1. 备份
cp "$CONFIG" "$BACKUP"
echo "✅ 已备份到: $BACKUP"

# 2. 用 dist/main/defaults.js 的默认值替换，并且 strip 一次确保只存"风格"
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { defaultConfig, stripPolishGuard } from './dist/main/defaults.js';

const cfg = JSON.parse(readFileSync(process.env.HOME + '/Library/Application Support/ai-voice-input/config.json', 'utf8'));
cfg.promptProfiles = defaultConfig.promptProfiles.map(p => ({
  id: p.id,
  name: p.name,
  prompts: {
    polish: stripPolishGuard(p.prompts.polish),
    qa: p.prompts.qa
  }
}));
cfg.activePromptProfileId = defaultConfig.activePromptProfileId;

writeFileSync(process.env.HOME + '/Library/Application Support/ai-voice-input/config.json', JSON.stringify(cfg, null, 2), 'utf8');
console.log('✅ 已重置 promptProfiles 为出厂默认值');
console.log('   - profile 数:', cfg.promptProfiles.length);
console.log('   - 激活:', cfg.activePromptProfileId);
"

echo ""
echo "📦 下一步：重新打开 AI Voice Input，提示词页应该是干净的 6 个出厂预设（无 POLISH_GUARD 标记）。"