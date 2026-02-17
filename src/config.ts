import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DevDayConfig, ToolName } from './types.js';

const CONFIG_DIR = join(homedir(), '.config', 'devday');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function getDefaultPaths() {
  const home = homedir();
  const platform = process.platform;

  return {
    opencodeStorage: join(home, '.local', 'share', 'opencode', 'storage'),
    claudeCodeHome: join(home, '.claude'),
    cursorStateDb: platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
      : platform === 'win32'
        ? join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
        : join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  };
}

function detectAvailableTools(): ToolName[] {
  const paths = getDefaultPaths();
  const tools: ToolName[] = [];

  if (existsSync(paths.opencodeStorage)) tools.push('opencode');
  if (existsSync(paths.claudeCodeHome)) tools.push('claude-code');
  if (existsSync(paths.cursorStateDb)) tools.push('cursor');

  return tools;
}

/**
 * Load config purely from environment variables + auto-detection.
 * API keys come from env vars only (CONCENTRATE_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY).
 * Tool paths are auto-detected. Non-sensitive preferences can be saved to config file.
 */
export function loadConfig(): DevDayConfig {
  const paths = getDefaultPaths();

  const concentrateKey = process.env.CONCENTRATE_API_KEY ?? null;
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? null;
  const openaiKey = process.env.OPENAI_API_KEY ?? null;

  // Prefer Concentrate (unified gateway, auto-routing), then OpenAI, then Anthropic
  let preferredSummarizer: 'concentrate' | 'anthropic' | 'openai' | 'none' = 'none';
  if (concentrateKey) preferredSummarizer = 'concentrate';
  else if (openaiKey) preferredSummarizer = 'openai';
  else if (anthropicKey) preferredSummarizer = 'anthropic';

  const defaults: DevDayConfig = {
    concentrateApiKey: concentrateKey,
    anthropicApiKey: anthropicKey,
    openaiApiKey: openaiKey,
    preferredSummarizer,
    paths: {
      opencodeStorage: existsSync(paths.opencodeStorage) ? paths.opencodeStorage : null,
      claudeCodeHome: existsSync(paths.claudeCodeHome) ? paths.claudeCodeHome : null,
      cursorStateDb: existsSync(paths.cursorStateDb) ? paths.cursorStateDb : null,
    },
    enabledTools: detectAvailableTools(),
    gitAuthorFilter: null,
  };

  // Merge non-sensitive preferences from config file (gitAuthorFilter, etc.)
  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      const saved = JSON.parse(raw) as Partial<DevDayConfig>;

      // Only merge non-sensitive fields — never read keys from file
      if (saved.gitAuthorFilter) defaults.gitAuthorFilter = saved.gitAuthorFilter;
      if (saved.enabledTools) defaults.enabledTools = saved.enabledTools;
    } catch {
      // Ignore corrupt config
    }
  }

  return defaults;
}

/**
 * Save non-sensitive preferences to config file.
 * API keys are NEVER written to disk.
 */
export function saveConfig(config: DevDayConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const safe = {
    gitAuthorFilter: config.gitAuthorFilter,
    enabledTools: config.enabledTools,
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(safe, null, 2), 'utf-8');
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
