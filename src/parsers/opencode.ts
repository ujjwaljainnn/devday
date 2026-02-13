import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { Parser, Session, TokenUsage } from '../types.js';
import { estimateCost, emptyTokenUsage, sumTokens } from '../cost.js';

// ── Raw JSON shapes from OpenCode storage ────────────────────────

interface OCProject {
  id: string;
  worktree: string;
  vcs?: string;
  time: { created: number; updated: number };
}

interface OCSession {
  id: string;
  slug?: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title?: string;
  time: { created: number; updated: number };
  summary?: { additions: number; deletions: number; files: number };
}

interface OCMessage {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant' | 'system';
  time: { created: number; completed?: number };
  modelID?: string;
  providerID?: string;
  agent?: string;
  cost: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache?: { read: number; write: number };
  };
  finish?: string;
}

interface OCPartText {
  type: 'text';
  text: string;
  time?: { start: number; end: number };
}

interface OCPartTool {
  type: 'tool';
  tool: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { start: number; end: number };
  };
}

interface OCPartPatch {
  type: 'patch';
  path?: string;
}

interface OCPartStepStart {
  type: 'step-start';
}

type OCPart = (OCPartText | OCPartTool | OCPartPatch | OCPartStepStart) & {
  id: string;
  sessionID: string;
  messageID: string;
};

// ── Parser ───────────────────────────────────────────────────────

export class OpenCodeParser implements Parser {
  readonly name = 'opencode' as const;
  private storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(this.storagePath) && existsSync(join(this.storagePath, 'project'));
  }

  async getSessions(date: string): Promise<Session[]> {
    // Parse YYYY-MM-DD and build day boundaries in local time manually.
    // Avoids date-fns startOfDay/endOfDay which can mishandle timezones.
    const [year, month, day] = date.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day, 23, 59, 59, 999);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();

    // 1. Load all projects
    const projects = this.loadProjects();
    const sessions: Session[] = [];

    for (const project of projects) {
      // Skip the "global" project (worktree = "/")
      if (project.worktree === '/') continue;

      // 2. Load sessions for this project
      const ocSessions = this.loadSessionsForProject(project.id);

      for (const ocSession of ocSessions) {
        // Filter by date: session must overlap with the target day
        const sessionCreated = new Date(ocSession.time.created);
        const sessionUpdated = new Date(ocSession.time.updated);

        const overlapsDay =
          (sessionCreated >= dayStart && sessionCreated <= dayEnd) ||
          (sessionUpdated >= dayStart && sessionUpdated <= dayEnd) ||
          (sessionCreated <= dayStart && sessionUpdated >= dayEnd);

        if (!overlapsDay) continue;

        // Skip sub-agent sessions (they have a parentID, their data is attributed to the parent)
        if (ocSession.parentID) continue;

        // 3. Load messages for this session (including sub-agent sessions)
        const childSessionIds = ocSessions
          .filter((s) => s.parentID === ocSession.id)
          .map((s) => s.id);

        const allSessionIds = [ocSession.id, ...childSessionIds];
        const messages = allSessionIds.flatMap((sid) => this.loadMessagesForSession(sid));

        // Filter messages to only those within the target day
        const dayMessages = messages.filter((m) => {
          const createdMs = m.time.created;
          return createdMs >= dayStartMs && createdMs <= dayEndMs;
        });

        if (dayMessages.length === 0) continue;

        // 4. Compute aggregates from messages
        const userMessages = dayMessages.filter((m) => m.role === 'user');
        const assistantMessages = dayMessages.filter((m) => m.role === 'assistant');
        const models = [...new Set(assistantMessages.map((m) => m.modelID).filter(Boolean))] as string[];

        // Token aggregation
        const tokenUsages: TokenUsage[] = dayMessages.map((m) => this.messageToTokens(m));
        const totalTokens = sumTokens(...tokenUsages);

        // Cost estimation (OpenCode cost field is always 0)
        let totalCost = 0;
        for (const msg of assistantMessages) {
          if (msg.modelID && msg.tokens) {
            totalCost += estimateCost(msg.modelID, this.messageToTokens(msg));
          }
        }

        // 5. Extract content: files touched, conversation text, tool call summaries
        const contentExtraction = this.extractSessionContent(dayMessages);

        // 6. Duration — sum actual message processing times, not wall-clock span
        //    Each message has created → completed timestamps representing active time.
        //    Clamp to target day boundaries to avoid cross-day inflation.
        //    Cap individual message duration at 5 minutes — no single LLM response
        //    should take longer; OpenCode sometimes writes bogus completed timestamps
        //    (e.g. reconciliation when session is loaded days later).
        const MAX_MSG_DURATION_MS = 5 * 60 * 1000; // 5 minutes
        let durationMs = 0;
        let earliestTs = Infinity;
        let latestTs = -Infinity;

        for (const msg of dayMessages) {
          const start = Math.max(dayStartMs, msg.time.created);
          const end = msg.time.completed
            ? Math.min(dayEndMs, msg.time.completed)
            : start; // no completion = instant

          if (end > start) {
            durationMs += Math.min(end - start, MAX_MSG_DURATION_MS);
          }

          if (msg.time.created < earliestTs) earliestTs = msg.time.created;
          const msgEnd = msg.time.completed ?? msg.time.created;
          if (msgEnd > latestTs) latestTs = msgEnd;
        }

        // Clamp start/end for display purposes
        const earliest = Math.max(dayStartMs, earliestTs);
        const latest = Math.min(dayEndMs, latestTs === -Infinity ? earliest : latestTs);

        // 7. Build topics from session title + summary
        const topics: string[] = [];
        if (ocSession.title) topics.push(ocSession.title);

        sessions.push({
          id: ocSession.id,
          tool: 'opencode',
          projectPath: project.worktree,
          projectName: basename(project.worktree),
          title: ocSession.title ?? ocSession.slug ?? null,
          startedAt: new Date(earliest),
          endedAt: new Date(latest),
          durationMs,
          messageCount: dayMessages.length,
          userMessageCount: userMessages.length,
          assistantMessageCount: assistantMessages.length,
          summary: ocSession.title ?? null,
          topics,
          tokens: totalTokens,
          costUsd: totalCost,
          models,
          filesTouched: contentExtraction.filesTouched,
          conversationDigest: contentExtraction.conversationDigest,
          toolCallSummaries: contentExtraction.toolCallSummaries,
        });
      }
    }

    return sessions;
  }

  // ── Internal helpers ─────────────────────────────────────────

  private loadProjects(): OCProject[] {
    const dir = join(this.storagePath, 'project');
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as OCProject;
        } catch {
          return null;
        }
      })
      .filter((p): p is OCProject => p !== null);
  }

  private loadSessionsForProject(projectId: string): OCSession[] {
    const dir = join(this.storagePath, 'session', projectId);
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as OCSession;
        } catch {
          return null;
        }
      })
      .filter((s): s is OCSession => s !== null);
  }

  private loadMessagesForSession(sessionId: string): OCMessage[] {
    const dir = join(this.storagePath, 'message', sessionId);
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as OCMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is OCMessage => m !== null);
  }

  private loadPartsForMessage(messageId: string): OCPart[] {
    const dir = join(this.storagePath, 'part', messageId);
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as OCPart;
        } catch {
          return null;
        }
      })
      .filter((p): p is OCPart => p !== null);
  }

  /**
   * Single-pass extraction of all session content:
   * - conversationDigest: user prompts + assistant text (for LLM summarization)
   * - toolCallSummaries: human-readable tool call descriptions
   * - filesTouched: unique file paths from tool calls and patches
   */
  private extractSessionContent(
    messages: OCMessage[],
  ): { conversationDigest: string; toolCallSummaries: string[]; filesTouched: string[] } {
    const digestParts: string[] = [];
    const toolSummaries: string[] = [];
    const files = new Set<string>();

    // Sort messages by creation time
    const sorted = [...messages].sort((a, b) => a.time.created - b.time.created);

    for (const msg of sorted) {
      const parts = this.loadPartsForMessage(msg.id);

      // Sort parts by their time if available
      const textParts: string[] = [];

      for (const part of parts) {
        if (part.type === 'text' && part.text) {
          textParts.push(part.text);
        }

        if (part.type === 'tool') {
          const toolPart = part as OCPart & OCPartTool;
          const toolName = toolPart.tool;
          const input = toolPart.state?.input;
          const title = toolPart.state?.title;

          // Build a human-readable tool call summary
          let summary = toolName;
          if (title) {
            summary = `${toolName}: ${title}`;
          } else if (input) {
            const filePath = (input.filePath ?? input.path ?? input.file) as string | undefined;
            const command = input.command as string | undefined;
            const pattern = input.pattern as string | undefined;

            if (filePath) {
              // Shorten to relative path (cross-platform)
              const home = homedir();
              const short = filePath.startsWith(home) ? '~' + filePath.slice(home.length) : filePath;
              summary = `${toolName} ${short}`;
            } else if (command) {
              summary = `bash: ${String(command).slice(0, 80)}`;
            } else if (pattern) {
              summary = `${toolName}: ${pattern}`;
            }
          }
          toolSummaries.push(summary);

          // Extract file paths
          if (input) {
            if (typeof input.filePath === 'string') files.add(input.filePath);
            if (typeof input.path === 'string') files.add(input.path);
            if (typeof input.file === 'string') files.add(input.file);
          }
        }

        if (part.type === 'patch') {
          const patchPart = part as OCPart & OCPartPatch;
          if (patchPart.path) {
            files.add(patchPart.path);
            toolSummaries.push(`patch: ${patchPart.path}`);
          }
        }
      }

      // Add to conversation digest
      if (textParts.length > 0) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const text = textParts.join('\n');
        // Truncate individual messages to keep digest manageable
        const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;
        digestParts.push(`[${role}]: ${truncated}`);
      }
    }

    // Cap total digest at ~4000 chars (fits in an LLM context easily)
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

  private messageToTokens(msg: OCMessage): TokenUsage {
    if (!msg.tokens) return emptyTokenUsage();

    const input = msg.tokens.input ?? 0;
    const output = msg.tokens.output ?? 0;
    const reasoning = msg.tokens.reasoning ?? 0;
    const cacheRead = msg.tokens.cache?.read ?? 0;
    const cacheWrite = msg.tokens.cache?.write ?? 0;

    return {
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      total: input + output + reasoning + cacheRead + cacheWrite,
    };
  }
}
