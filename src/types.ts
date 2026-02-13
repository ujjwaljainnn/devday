// ── Tool identifiers ──────────────────────────────────────────────
export type ToolName = 'opencode' | 'claude-code' | 'cursor';

// ── Unified session representation ───────────────────────────────
export interface Session {
  id: string;
  tool: ToolName;
  projectPath: string | null;    // absolute path to the repo/project
  projectName: string | null;    // human-readable name
  title: string | null;          // session title / conversation name
  startedAt: Date;
  endedAt: Date;
  durationMs: number;

  // Content
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  summary: string | null;         // pre-existing summary from the tool
  topics: string[];               // extracted topics / file names / keywords

  // Tokens & cost
  tokens: TokenUsage;
  costUsd: number;                // estimated or actual cost

  // Model info
  models: string[];               // unique models used in this session

  // Files touched (from tool calls within the session)
  filesTouched: string[];

  // Extracted conversation content for summarization
  // User prompts + assistant text responses (truncated, no tool output blobs)
  conversationDigest: string;
  toolCallSummaries: string[];    // e.g. ["read app/models/llm.py", "edit app/routes/deals.py"]
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

// ── Git activity ─────────────────────────────────────────────────
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  timestamp: Date;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

export interface GitActivity {
  projectPath: string;
  projectName: string;
  commits: GitCommit[];
  totalFilesChanged: number;
  totalInsertions: number;
  totalDeletions: number;
}

// ── Project-level summary ────────────────────────────────────────
export interface ProjectSummary {
  projectPath: string;
  projectName: string;
  sessions: Session[];
  git: GitActivity | null;

  // Aggregates
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  toolsUsed: ToolName[];
  modelsUsed: string[];
  filesTouched: string[];

  // Generated
  aiSummary: string | null;       // LLM-generated summary
}

// ── Day-level recap ──────────────────────────────────────────────
export interface DayRecap {
  date: string;                   // YYYY-MM-DD
  projects: ProjectSummary[];

  // Global aggregates
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  toolsUsed: ToolName[];

  // Generated content
  standupMessage: string | null;  // short standup-ready summary
}

// ── Config ───────────────────────────────────────────────────────
export interface DevDayConfig {
  // API keys for summarization
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  preferredSummarizer: 'anthropic' | 'openai' | 'none';

  // Tool-specific paths (auto-detected, user-overridable)
  paths: {
    opencodeStorage: string | null;   // ~/.local/share/opencode/storage
    claudeCodeHome: string | null;    // ~/.claude
    cursorStateDb: string | null;     // ~/Library/Application Support/Cursor/...
  };

  // Which tools to scan
  enabledTools: ToolName[];

  // Git
  gitAuthorFilter: string | null;     // filter commits by author email/name
}

// ── Parser interface ─────────────────────────────────────────────
export interface Parser {
  name: ToolName;
  isAvailable(): Promise<boolean>;
  getSessions(date: string): Promise<Session[]>; // date = YYYY-MM-DD
}

// ── Model pricing (per million tokens) ───────────────────────────
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-sonnet-4-20250514': { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
  'claude-3-5-haiku-20241022': { inputPerMillion: 0.8, outputPerMillion: 4, cacheReadPerMillion: 0.08, cacheWritePerMillion: 1 },
  'claude-opus-4-20250514': { inputPerMillion: 15, outputPerMillion: 75, cacheReadPerMillion: 1.5, cacheWritePerMillion: 18.75 },
  'claude-3-opus-20240229': { inputPerMillion: 15, outputPerMillion: 75 },

  // OpenAI
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'o1': { inputPerMillion: 15, outputPerMillion: 60 },
  'o1-mini': { inputPerMillion: 3, outputPerMillion: 12 },
  'o3-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  'gpt-4-turbo': { inputPerMillion: 10, outputPerMillion: 30 },

  // Google
  'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'gemini-2.0-pro': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5 },

  // DeepSeek
  'deepseek-chat': { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  'deepseek-reasoner': { inputPerMillion: 0.55, outputPerMillion: 2.19 },
};
