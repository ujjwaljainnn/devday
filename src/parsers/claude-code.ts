import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { ReadonlyDatabase } from '../db.js';
import type { Parser, Session, TokenUsage } from '../types.js';
import { estimateCost, emptyTokenUsage, sumTokens } from '../cost.js';

// ── Raw shapes from Claude Code storage ──────────────────────────

interface CCSessionEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  messageCount: number;
  created: string;   // ISO 8601
  modified: string;  // ISO 8601
  gitBranch?: string;
  projectPath: string;
  summary?: string;
  isSidechain?: boolean;
}

interface CCSessionsIndex {
  version: number;
  entries: CCSessionEntry[];
}

/** Row from __store.db assistant_messages joined with base_messages */
interface AssistantRow {
  uuid: string;
  session_id: string;
  timestamp: number;      // ms epoch
  cost_usd: number | null;
  duration_ms: number | null;
  model: string | null;
  message: string;        // full Anthropic API message JSON
}

/** Row from __store.db user_messages joined with base_messages */
interface UserRow {
  uuid: string;
  session_id: string;
  timestamp: number;
  message: string;        // message JSON
}

// ── JSONL message shapes ─────────────────────────────────────────

interface JNLAssistantMessage {
  type: 'assistant';
  uuid: string;
  sessionId: string;
  timestamp: string;
  message: {
    id: string;
    role: 'assistant';
    model?: string;
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

interface JNLUserMessage {
  type: 'user';
  uuid: string;
  sessionId: string;
  timestamp: string;
  message: {
    role: 'user';
    content: string | Array<{ type: string; text?: string; tool_use_id?: string; content?: string }>;
  };
}

type JNLLine = JNLAssistantMessage | JNLUserMessage | { type: string };

// ── Parser ───────────────────────────────────────────────────────

export class ClaudeCodeParser implements Parser {
  readonly name = 'claude-code' as const;
  private claudeHome: string;

  constructor(claudeHome: string) {
    this.claudeHome = claudeHome;
  }

  async isAvailable(): Promise<boolean> {
    return (
      existsSync(this.claudeHome) &&
      existsSync(join(this.claudeHome, 'projects'))
    );
  }

  async getSessions(date: string): Promise<Session[]> {
    // Build day boundaries in local time
    const [year, month, day] = date.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day, 23, 59, 59, 999);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();

    const projectsDir = join(this.claudeHome, 'projects');
    if (!existsSync(projectsDir)) return [];

    // Open SQLite for cost/duration data (optional — parser works without it)
    const dbPath = join(this.claudeHome, '__store.db');
    let db: ReadonlyDatabase | null = null;
    if (existsSync(dbPath)) {
      try {
        db = await ReadonlyDatabase.open(dbPath);
      } catch {
        // Can't open DB — continue without it
      }
    }

    const sessions: Session[] = [];

    try {
      const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());

      for (const projDir of projectDirs) {
        const projPath = join(projectsDir, projDir.name);
        const indexPath = join(projPath, 'sessions-index.json');
        if (!existsSync(indexPath)) continue;

        let index: CCSessionsIndex;
        try {
          index = JSON.parse(readFileSync(indexPath, 'utf-8')) as CCSessionsIndex;
        } catch {
          continue;
        }

        // Get the real project path from the first session entry
        // (directory name encoding is lossy — dashes in dir names become ambiguous)
        const projectPath = index.entries[0]?.projectPath ?? projDir.name.replace(/^-/, '/').replace(/-/g, '/');
        const projectName = basename(projectPath);

        for (const entry of index.entries) {
          if (entry.isSidechain) continue;

          // Filter by date: session must overlap with the target day
          const createdMs = new Date(entry.created).getTime();
          const modifiedMs = new Date(entry.modified).getTime();

          const overlapsDay =
            (createdMs >= dayStartMs && createdMs <= dayEndMs) ||
            (modifiedMs >= dayStartMs && modifiedMs <= dayEndMs) ||
            (createdMs <= dayStartMs && modifiedMs >= dayEndMs);

          if (!overlapsDay) continue;

          // Build session from JSONL + optional DB data
          const session = this.buildSession(
            entry,
            projectPath,
            projectName,
            dayStartMs,
            dayEndMs,
            db,
          );
          if (session) sessions.push(session);
        }
      }
    } finally {
      db?.close();
    }

    return sessions;
  }

  // ── Build a single session ──────────────────────────────────────

  private buildSession(
    entry: CCSessionEntry,
    projectPath: string,
    projectName: string,
    dayStartMs: number,
    dayEndMs: number,
    db: ReadonlyDatabase | null,
  ): Session | null {
    // Try DB-based approach first (more structured)
    if (db) {
      const dbSession = this.buildSessionFromDb(entry, projectPath, projectName, dayStartMs, dayEndMs, db);
      if (dbSession) return dbSession;
    }

    // Fall back to JSONL parsing
    return this.buildSessionFromJsonl(entry, projectPath, projectName, dayStartMs, dayEndMs);
  }

  // ── DB-based session building ───────────────────────────────────

  private buildSessionFromDb(
    entry: CCSessionEntry,
    projectPath: string,
    projectName: string,
    dayStartMs: number,
    dayEndMs: number,
    db: ReadonlyDatabase,
  ): Session | null {
    try {
      // Get assistant messages for this session within the target day
      const assistantRows = db.all<AssistantRow>(`
        SELECT b.uuid, b.session_id, b.timestamp, a.cost_usd, a.duration_ms, a.model, a.message
        FROM base_messages b
        JOIN assistant_messages a ON a.uuid = b.uuid
        WHERE b.session_id = ? AND b.timestamp >= ? AND b.timestamp <= ?
        ORDER BY b.timestamp
      `, entry.sessionId, dayStartMs, dayEndMs);

      const userRows = db.all<UserRow>(`
        SELECT b.uuid, b.session_id, b.timestamp, u.message
        FROM base_messages b
        JOIN user_messages u ON u.uuid = b.uuid
        WHERE b.session_id = ? AND b.timestamp >= ? AND b.timestamp <= ?
        ORDER BY b.timestamp
      `, entry.sessionId, dayStartMs, dayEndMs);

      const totalMessages = assistantRows.length + userRows.length;
      if (totalMessages === 0) return null;

      // Aggregate cost and duration
      let totalCost = 0;
      let totalDurationMs = 0;
      const MAX_MSG_DURATION_MS = 5 * 60 * 1000;
      const models = new Set<string>();
      const totalTokens = emptyTokenUsage();

      for (const row of assistantRows) {
        if (row.cost_usd) totalCost += row.cost_usd;
        if (row.duration_ms) {
          totalDurationMs += Math.min(row.duration_ms, MAX_MSG_DURATION_MS);
        }
        if (row.model) models.add(row.model);

        // Parse usage from the full message JSON
        try {
          const msg = JSON.parse(row.message) as { usage?: Record<string, number> };
          if (msg.usage) {
            const u = msg.usage;
            totalTokens.input += u.input_tokens ?? 0;
            totalTokens.output += u.output_tokens ?? 0;
            totalTokens.cacheRead += u.cache_read_input_tokens ?? 0;
            totalTokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
          }
        } catch {
          // skip
        }
      }

      totalTokens.total = totalTokens.input + totalTokens.output + totalTokens.cacheRead + totalTokens.cacheWrite;

      // If no cost from DB, estimate from tokens
      if (totalCost === 0 && totalTokens.total > 0 && models.size > 0) {
        const model = [...models][0];
        totalCost = estimateCost(model, totalTokens);
      }

      // Extract content from JSONL for conversation digest
      const contentExtraction = this.extractContentFromJsonl(entry.fullPath, dayStartMs, dayEndMs);

      // Timestamps
      const allTimestamps = [
        ...assistantRows.map((r) => r.timestamp),
        ...userRows.map((r) => r.timestamp),
      ];
      const earliest = Math.max(dayStartMs, Math.min(...allTimestamps));
      const latest = Math.min(dayEndMs, Math.max(...allTimestamps));

      return {
        id: entry.sessionId,
        tool: 'claude-code',
        projectPath,
        projectName,
        title: entry.summary ?? this.truncatePrompt(entry.firstPrompt) ?? null,
        startedAt: new Date(earliest),
        endedAt: new Date(latest),
        durationMs: totalDurationMs,
        messageCount: totalMessages,
        userMessageCount: userRows.length,
        assistantMessageCount: assistantRows.length,
        summary: entry.summary ?? null,
        topics: entry.summary ? [entry.summary] : [],
        tokens: totalTokens,
        costUsd: totalCost,
        models: [...models],
        filesTouched: contentExtraction.filesTouched,
        conversationDigest: contentExtraction.conversationDigest,
        toolCallSummaries: contentExtraction.toolCallSummaries,
      };
    } catch {
      return null;
    }
  }

  // ── JSONL-based session building (fallback) ─────────────────────

  private buildSessionFromJsonl(
    entry: CCSessionEntry,
    projectPath: string,
    projectName: string,
    dayStartMs: number,
    dayEndMs: number,
  ): Session | null {
    if (!existsSync(entry.fullPath)) return null;

    const messages = this.parseJsonlFile(entry.fullPath, dayStartMs, dayEndMs);
    if (messages.user.length === 0 && messages.assistant.length === 0) return null;

    const MAX_MSG_DURATION_MS = 5 * 60 * 1000;
    const models = new Set<string>();
    const totalTokens = emptyTokenUsage();
    let totalCost = 0;
    let totalDurationMs = 0;

    // Deduplicate assistant messages by message.id (streaming chunks)
    const dedupedAssistant = this.deduplicateAssistant(messages.assistant);

    for (const msg of dedupedAssistant) {
      if (msg.message.model) models.add(msg.message.model);
      if (msg.message.usage) {
        const u = msg.message.usage;
        totalTokens.input += u.input_tokens ?? 0;
        totalTokens.output += u.output_tokens ?? 0;
        totalTokens.cacheRead += u.cache_read_input_tokens ?? 0;
        totalTokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
      }
    }

    totalTokens.total = totalTokens.input + totalTokens.output + totalTokens.cacheRead + totalTokens.cacheWrite;

    if (totalTokens.total > 0 && models.size > 0) {
      totalCost = estimateCost([...models][0], totalTokens);
    }

    // Estimate duration from timestamp gaps between consecutive messages
    const allTimestamps = [
      ...messages.user.map((m) => new Date(m.timestamp).getTime()),
      ...messages.assistant.map((m) => new Date(m.timestamp).getTime()),
    ].sort((a, b) => a - b);

    for (let i = 1; i < allTimestamps.length; i++) {
      const gap = allTimestamps[i] - allTimestamps[i - 1];
      totalDurationMs += Math.min(gap, MAX_MSG_DURATION_MS);
    }

    const contentExtraction = this.extractContentFromMessages(messages, dayStartMs, dayEndMs);

    const earliest = Math.max(dayStartMs, allTimestamps[0] ?? dayStartMs);
    const latest = Math.min(dayEndMs, allTimestamps[allTimestamps.length - 1] ?? dayEndMs);

    return {
      id: entry.sessionId,
      tool: 'claude-code',
      projectPath,
      projectName,
      title: entry.summary ?? this.truncatePrompt(entry.firstPrompt) ?? null,
      startedAt: new Date(earliest),
      endedAt: new Date(latest),
      durationMs: totalDurationMs,
      messageCount: messages.user.length + dedupedAssistant.length,
      userMessageCount: messages.user.length,
      assistantMessageCount: dedupedAssistant.length,
      summary: entry.summary ?? null,
      topics: entry.summary ? [entry.summary] : [],
      tokens: totalTokens,
      costUsd: totalCost,
      models: [...models],
      filesTouched: contentExtraction.filesTouched,
      conversationDigest: contentExtraction.conversationDigest,
      toolCallSummaries: contentExtraction.toolCallSummaries,
    };
  }

  // ── JSONL parsing ───────────────────────────────────────────────

  private parseJsonlFile(
    filePath: string,
    dayStartMs: number,
    dayEndMs: number,
  ): { user: JNLUserMessage[]; assistant: JNLAssistantMessage[] } {
    const user: JNLUserMessage[] = [];
    const assistant: JNLAssistantMessage[] = [];

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return { user, assistant };
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as JNLLine;

        if (obj.type === 'user') {
          const msg = obj as JNLUserMessage;
          const ts = new Date(msg.timestamp).getTime();
          if (ts >= dayStartMs && ts <= dayEndMs) {
            user.push(msg);
          }
        } else if (obj.type === 'assistant') {
          const msg = obj as JNLAssistantMessage;
          const ts = new Date(msg.timestamp).getTime();
          if (ts >= dayStartMs && ts <= dayEndMs) {
            assistant.push(msg);
          }
        }
        // Skip file-history-snapshot, progress, system types
      } catch {
        // skip malformed lines
      }
    }

    return { user, assistant };
  }

  /** Deduplicate assistant messages: streaming chunks share the same message.id */
  private deduplicateAssistant(msgs: JNLAssistantMessage[]): JNLAssistantMessage[] {
    const byMsgId = new Map<string, JNLAssistantMessage>();
    for (const msg of msgs) {
      const key = msg.message.id;
      // Keep the last chunk (most complete content)
      byMsgId.set(key, msg);
    }
    return [...byMsgId.values()];
  }

  // ── Content extraction from JSONL ───────────────────────────────

  private extractContentFromJsonl(
    filePath: string,
    dayStartMs: number,
    dayEndMs: number,
  ): { conversationDigest: string; toolCallSummaries: string[]; filesTouched: string[] } {
    if (!existsSync(filePath)) {
      return { conversationDigest: '', toolCallSummaries: [], filesTouched: [] };
    }

    const messages = this.parseJsonlFile(filePath, dayStartMs, dayEndMs);
    return this.extractContentFromMessages(messages, dayStartMs, dayEndMs);
  }

  private extractContentFromMessages(
    messages: { user: JNLUserMessage[]; assistant: JNLAssistantMessage[] },
    _dayStartMs: number,
    _dayEndMs: number,
  ): { conversationDigest: string; toolCallSummaries: string[]; filesTouched: string[] } {
    const digestParts: string[] = [];
    const toolSummaries: string[] = [];
    const files = new Set<string>();
    const home = homedir();

    // Combine and sort by timestamp
    type Tagged = { ts: number; role: 'user' | 'assistant'; msg: JNLUserMessage | JNLAssistantMessage };
    const all: Tagged[] = [
      ...messages.user.map((m): Tagged => ({ ts: new Date(m.timestamp).getTime(), role: 'user', msg: m })),
      ...messages.assistant.map((m): Tagged => ({ ts: new Date(m.timestamp).getTime(), role: 'assistant', msg: m })),
    ].sort((a, b) => a.ts - b.ts);

    // Deduplicate assistant messages
    const seenMsgIds = new Set<string>();

    for (const { role, msg } of all) {
      if (role === 'user') {
        const userMsg = msg as JNLUserMessage;
        const content = userMsg.message.content;

        // Only include human text, not tool results
        if (typeof content === 'string') {
          const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
          digestParts.push(`[User]: ${truncated}`);
        }
        // Array content with tool_result entries → skip for digest
      } else {
        const assistantMsg = msg as JNLAssistantMessage;
        const msgId = assistantMsg.message.id;

        // Skip duplicate streaming chunks
        if (seenMsgIds.has(msgId)) continue;
        seenMsgIds.add(msgId);

        const contentBlocks = assistantMsg.message.content ?? [];
        const textParts: string[] = [];

        for (const block of contentBlocks) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }

          if (block.type === 'tool_use' && block.name) {
            const input = block.input ?? {};
            let summary = block.name;

            const filePath = (input.filePath ?? input.path ?? input.file) as string | undefined;
            const command = input.command as string | undefined;
            const pattern = input.pattern as string | undefined;

            if (filePath) {
              const short = filePath.startsWith(home) ? '~' + filePath.slice(home.length) : filePath;
              summary = `${block.name} ${short}`;
              files.add(filePath);
            } else if (command) {
              summary = `bash: ${String(command).slice(0, 80)}`;
            } else if (pattern) {
              summary = `${block.name}: ${pattern}`;
            }

            toolSummaries.push(summary);
          }
        }

        if (textParts.length > 0) {
          const text = textParts.join('\n');
          const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;
          digestParts.push(`[Assistant]: ${truncated}`);
        }
      }
    }

    // Cap total digest
    let conversationDigest = digestParts.join('\n\n');
    if (conversationDigest.length > 4000) {
      conversationDigest = conversationDigest.slice(0, 4000) + '\n\n[...truncated]';
    }

    return {
      conversationDigest,
      toolCallSummaries: toolSummaries,
      filesTouched: [...files],
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private truncatePrompt(prompt: string | undefined): string | null {
    if (!prompt) return null;
    const clean = prompt.replace(/\n/g, ' ').trim();
    if (clean.length <= 60) return clean;
    return clean.slice(0, 57) + '...';
  }
}
