import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import type { Parser, Session } from '../types.js';
import { estimateCost, emptyTokenUsage, sumTokens } from '../cost.js';

// ── Raw shapes from Cursor storage ───────────────────────────────

interface CursorComposerData {
  _v?: number;
  composerId: string;
  name?: string;
  subtitle?: string;
  status?: string;
  createdAt?: number;           // Unix ms
  lastUpdatedAt?: number;       // Unix ms
  unifiedMode?: string;         // "agent" | "chat"
  modelConfig?: { modelName?: string };
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  filesChangedCount?: number;
  // v1: inline messages
  conversation?: CursorBubble[];
  // v3+: message headers (ordering)
  fullConversationHeadersOnly?: Array<{ bubbleId: string; type: number; serverBubbleId?: string }>;
  // v3+: sometimes inline map (often empty — data in separate KV entries)
  conversationMap?: Record<string, CursorBubble>;
  context?: {
    fileSelections?: unknown[];
    folderSelections?: unknown[];
    selections?: unknown[];
    terminalSelections?: unknown[];
    mentions?: {
      fileSelections?: Record<string, unknown>;
      folderSelections?: Record<string, unknown>;
      selections?: Record<string, unknown>;
      terminalSelections?: Record<string, unknown>;
    };
  };
  originalFileStates?: Record<string, unknown>;
  codeBlockData?: Record<string, unknown>;
  newlyCreatedFiles?: unknown[];
  newlyCreatedFolders?: unknown[];
}

interface CursorBubble {
  _v?: number;
  type?: number;                // 1 = user, 2 = AI
  bubbleId?: string;
  text?: string;
  createdAt?: string;           // ISO 8601 (v3 only)
  cwd?: string;
  tokenCount?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  timingInfo?: {
    clientRpcSendTime?: number; // Unix ms
    clientSettleTime?: number;  // Unix ms
    clientEndTime?: number;     // Unix ms
  };
  modelInfo?: { modelName?: string };
  codeBlocks?: Array<{
    uri?: { path?: string; fsPath?: string };
    content?: string;
    languageId?: string;
  }>;
  thinking?: { text?: string };
}

interface LoadedBubbles {
  dayBubbles: CursorBubble[];
  allBubbles: CursorBubble[];
}

// ── Parser ───────────────────────────────────────────────────────

export class CursorParser implements Parser {
  readonly name = 'cursor' as const;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(this.dbPath);
  }

  async getSessions(date: string): Promise<Session[]> {
    // Build day boundaries in local time
    const [year, month, day] = date.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day, 23, 59, 59, 999);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();

    let db: InstanceType<typeof Database>;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch {
      return [];
    }

    const sessions: Session[] = [];

    try {
      // 1. Load all composerData entries
      const rows = db.prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
      ).all() as Array<{ key: string; value: string | Buffer }>;

      for (const row of rows) {
        let composer: CursorComposerData;
        try {
          const val = typeof row.value === 'string' ? row.value : row.value.toString('utf-8');
          composer = JSON.parse(val) as CursorComposerData;
        } catch {
          continue;
        }

        if (!composer.composerId) continue;

        // 2. Date filter: session must overlap with target day
        const createdMs = composer.createdAt ?? 0;
        const updatedMs = composer.lastUpdatedAt ?? createdMs;

        const overlapsDay =
          (createdMs >= dayStartMs && createdMs <= dayEndMs) ||
          (updatedMs >= dayStartMs && updatedMs <= dayEndMs) ||
          (createdMs <= dayStartMs && updatedMs >= dayEndMs);

        if (!overlapsDay) continue;

        // 3. Load bubbles for this session
        const loadedBubbles = this.loadBubbles(db, composer, dayStartMs, dayEndMs);
        if (loadedBubbles.dayBubbles.length === 0) continue;

        // 4. Build session
        const session = this.buildSession(
          composer,
          loadedBubbles.dayBubbles,
          loadedBubbles.allBubbles,
          dayStartMs,
          dayEndMs,
        );
        if (session) sessions.push(session);
      }
    } finally {
      db.close();
    }

    return sessions;
  }

  // ── Load bubbles ────────────────────────────────────────────────

  private loadBubbles(
    db: InstanceType<typeof Database>,
    composer: CursorComposerData,
    dayStartMs: number,
    dayEndMs: number,
  ): LoadedBubbles {
    const dayBubbles: CursorBubble[] = [];
    const allBubbles: CursorBubble[] = [];

    // Strategy 1: v1 inline conversation array
    if (composer.conversation && Array.isArray(composer.conversation)) {
      for (const bubble of composer.conversation) {
        allBubbles.push(bubble);
        if (this.bubbleInDay(bubble, composer, dayStartMs, dayEndMs)) {
          dayBubbles.push(bubble);
        }
      }
      if (dayBubbles.length > 0) return { dayBubbles, allBubbles };
    }

    // Strategy 2: v3+ — load from separate KV entries
    const headers = composer.fullConversationHeadersOnly;
    if (headers && headers.length > 0) {
      // Batch query: get all bubbles for this composer at once
      const composerId = composer.composerId;
      const rows = db.prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE ?",
      ).all(`bubbleId:${composerId}:%`) as Array<{ key: string; value: string | Buffer }>;

      const bubbleMap = new Map<string, CursorBubble>();
      for (const row of rows) {
        try {
          const val = typeof row.value === 'string' ? row.value : row.value.toString('utf-8');
          const bubble = JSON.parse(val) as CursorBubble;
          // Extract bubbleId from key: "bubbleId:{composerId}:{bubbleId}"
          const parts = (row.key as string).split(':');
          const bubbleId = parts.slice(2).join(':'); // rejoin in case bubbleId contains ':'
          if (bubble && bubbleId) {
            bubble.bubbleId = bubble.bubbleId ?? bubbleId;
            bubbleMap.set(bubbleId, bubble);
          }
        } catch {
          // skip
        }
      }

      // Also check conversationMap (sometimes data is inline)
      if (composer.conversationMap) {
        for (const [id, bubble] of Object.entries(composer.conversationMap)) {
          if (bubble && typeof bubble === 'object' && !bubbleMap.has(id)) {
            bubble.bubbleId = bubble.bubbleId ?? id;
            bubbleMap.set(id, bubble);
          }
        }
      }

      // Return in conversation order, filtered by day
      for (const header of headers) {
        const bubble = bubbleMap.get(header.bubbleId);
        if (!bubble || !bubble.type) continue;

        allBubbles.push(bubble);
        if (this.bubbleInDay(bubble, composer, dayStartMs, dayEndMs)) {
          dayBubbles.push(bubble);
        }
      }
    }

    return { dayBubbles, allBubbles };
  }

  /** Check if a bubble's timestamp falls within the target day */
  private bubbleInDay(
    bubble: CursorBubble,
    composer: CursorComposerData,
    dayStartMs: number,
    dayEndMs: number,
  ): boolean {
    const ts = this.getBubbleTimestamp(bubble, composer);
    if (ts === null) return true; // no timestamp — include by default (session already filtered)
    return ts >= dayStartMs && ts <= dayEndMs;
  }

  /** Extract the best available timestamp from a bubble (ms epoch) */
  private getBubbleTimestamp(bubble: CursorBubble, composer: CursorComposerData): number | null {
    // Prefer timingInfo (most reliable Unix ms timestamp)
    if (bubble.timingInfo?.clientRpcSendTime) {
      return bubble.timingInfo.clientRpcSendTime;
    }
    // v3 createdAt is ISO string
    if (bubble.createdAt) {
      const ts = new Date(bubble.createdAt).getTime();
      if (!isNaN(ts)) return ts;
    }
    // Fall back to composer-level timestamps
    return null;
  }

  // ── Build session from bubbles ──────────────────────────────────

  private buildSession(
    composer: CursorComposerData,
    bubbles: CursorBubble[],
    allBubbles: CursorBubble[],
    dayStartMs: number,
    dayEndMs: number,
  ): Session | null {
    const MAX_MSG_DURATION_MS = 5 * 60 * 1000;
    const home = homedir();

    const userBubbles = bubbles.filter((b) => b.type === 1);
    const aiBubbles = bubbles.filter((b) => b.type === 2);

    if (userBubbles.length === 0 && aiBubbles.length === 0) return null;

    // ── Model detection ───────────────────────────────────────
    const models = new Set<string>();
    for (const b of aiBubbles) {
      const raw = b.modelInfo?.modelName ?? composer.modelConfig?.modelName;
      if (raw) models.add(raw);
    }
    if (models.size === 0 && composer.modelConfig?.modelName) {
      models.add(composer.modelConfig.modelName);
    }

    // ── Token aggregation ─────────────────────────────────────
    const totalTokens = emptyTokenUsage();
    for (const b of aiBubbles) {
      if (b.tokenCount) {
        totalTokens.input += b.tokenCount.inputTokens ?? 0;
        totalTokens.output += b.tokenCount.outputTokens ?? 0;
      }
    }
    totalTokens.total = totalTokens.input + totalTokens.output;

    // ── Cost estimation ───────────────────────────────────────
    let totalCost = 0;
    if (totalTokens.total > 0 && models.size > 0) {
      totalCost = estimateCost([...models][0], totalTokens);
    }

    // ── Duration ──────────────────────────────────────────────
    let totalDurationMs = 0;
    for (const b of aiBubbles) {
      const ti = b.timingInfo;
      if (ti?.clientRpcSendTime && ti?.clientEndTime) {
        const dur = ti.clientEndTime - ti.clientRpcSendTime;
        if (dur > 0) {
          totalDurationMs += Math.min(dur, MAX_MSG_DURATION_MS);
        }
      }
    }

    // Fallback: if no timingInfo, estimate from timestamp gaps
    if (totalDurationMs === 0 && bubbles.length > 1) {
      const timestamps = bubbles
        .map((b) => this.getBubbleTimestamp(b, composer))
        .filter((t): t is number => t !== null)
        .sort((a, b) => a - b);

      for (let i = 1; i < timestamps.length; i++) {
        const gap = timestamps[i] - timestamps[i - 1];
        if (gap > 0) {
          totalDurationMs += Math.min(gap, MAX_MSG_DURATION_MS);
        }
      }
    }

    // ── Project path ──────────────────────────────────────────
    const projectPath = this.resolveProjectPath(composer, allBubbles);

    // ── Timestamps ────────────────────────────────────────────
    const allTimestamps = bubbles
      .map((b) => this.getBubbleTimestamp(b, composer))
      .filter((t): t is number => t !== null);

    const earliest = allTimestamps.length > 0
      ? Math.max(dayStartMs, Math.min(...allTimestamps))
      : composer.createdAt ?? dayStartMs;
    const latest = allTimestamps.length > 0
      ? Math.min(dayEndMs, Math.max(...allTimestamps))
      : composer.lastUpdatedAt ?? dayEndMs;

    // ── Content extraction ────────────────────────────────────
    const digestParts: string[] = [];
    const toolSummaries: string[] = [];
    const files = new Set<string>();

    for (const b of bubbles) {
      if (!b.text?.trim()) continue;

      if (b.type === 1) {
        const truncated = b.text.length > 500 ? b.text.slice(0, 500) + '...' : b.text;
        digestParts.push(`[User]: ${truncated}`);
      } else if (b.type === 2) {
        const truncated = b.text.length > 500 ? b.text.slice(0, 500) + '...' : b.text;
        digestParts.push(`[Assistant]: ${truncated}`);
      }

      // Extract files from code blocks
      if (b.codeBlocks) {
        for (const cb of b.codeBlocks) {
          const filePath = cb.uri?.fsPath ?? cb.uri?.path;
          if (filePath) {
            files.add(filePath);
            const short = filePath.startsWith(home) ? '~' + filePath.slice(home.length) : filePath;
            toolSummaries.push(`edit ${short}`);
          }
        }
      }
    }

    // Cap digest
    let conversationDigest = digestParts.join('\n\n');
    if (conversationDigest.length > 4000) {
      conversationDigest = conversationDigest.slice(0, 4000) + '\n\n[...truncated]';
    }

    // Dedup tool summaries
    const uniqueToolSummaries = [...new Set(toolSummaries)];

    // ── Title ─────────────────────────────────────────────────
    const title = composer.name ?? null;

    // ── Topics ────────────────────────────────────────────────
    const topics: string[] = [];
    if (composer.name) topics.push(composer.name);
    if (composer.subtitle) topics.push(composer.subtitle);

    // Keep the exact model names reported by Cursor metadata.
    const displayModels = [...models];

    return {
      id: composer.composerId,
      tool: 'cursor',
      projectPath,
      projectName: projectPath ? basename(projectPath) : null,
      title,
      startedAt: new Date(earliest),
      endedAt: new Date(latest),
      durationMs: totalDurationMs,
      messageCount: bubbles.length,
      userMessageCount: userBubbles.length,
      assistantMessageCount: aiBubbles.length,
      summary: composer.name ?? null,
      topics,
      tokens: totalTokens,
      costUsd: totalCost,
      models: displayModels,
      filesTouched: [...files],
      conversationDigest,
      toolCallSummaries: uniqueToolSummaries,
    };
  }

  private resolveProjectPath(composer: CursorComposerData, bubbles: CursorBubble[]): string | null {
    const candidates = new Set<string>();

    for (const b of bubbles) {
      this.addPathCandidate(candidates, b.cwd);
      if (!b.codeBlocks) continue;
      for (const cb of b.codeBlocks) {
        this.addPathCandidate(candidates, cb.uri?.fsPath);
        this.addPathCandidate(candidates, cb.uri?.path);
      }
    }

    this.addComposerPathCandidates(composer, candidates);

    for (const candidate of candidates) {
      const gitRoot = this.findGitRoot(candidate);
      if (gitRoot) return gitRoot;
    }

    for (const candidate of candidates) {
      const existingDir = this.toExistingDirectory(candidate);
      if (existingDir) return existingDir;
    }

    return null;
  }

  private addComposerPathCandidates(composer: CursorComposerData, out: Set<string>): void {
    const mentions = composer.context?.mentions;
    if (mentions) {
      this.addSelectionRecordPathCandidates(out, mentions.fileSelections);
      this.addSelectionRecordPathCandidates(out, mentions.folderSelections);
      this.addSelectionRecordPathCandidates(out, mentions.selections);
      this.addSelectionRecordPathCandidates(out, mentions.terminalSelections);
    }

    this.addSelectionListPathCandidates(out, composer.context?.fileSelections);
    this.addSelectionListPathCandidates(out, composer.context?.folderSelections);
    this.addSelectionListPathCandidates(out, composer.context?.selections);
    this.addSelectionListPathCandidates(out, composer.context?.terminalSelections);
    this.addSelectionListPathCandidates(out, composer.newlyCreatedFiles);
    this.addSelectionListPathCandidates(out, composer.newlyCreatedFolders);

    if (composer.originalFileStates) {
      for (const key of Object.keys(composer.originalFileStates)) {
        this.addPathCandidate(out, key);
      }
    }
    if (composer.codeBlockData) {
      for (const key of Object.keys(composer.codeBlockData)) {
        this.addPathCandidate(out, key);
      }
    }
  }

  private addSelectionRecordPathCandidates(
    out: Set<string>,
    record: Record<string, unknown> | undefined,
  ): void {
    if (!record) return;
    for (const key of Object.keys(record)) {
      this.addPathCandidate(out, key);

      // Cursor stores many mentions as serialized JSON with uri/path fields.
      try {
        const parsed = JSON.parse(key) as unknown;
        this.addPathCandidateFromUnknown(out, parsed);
      } catch {
        // key wasn't JSON
      }
    }
  }

  private addSelectionListPathCandidates(out: Set<string>, items: unknown[] | undefined): void {
    if (!items) return;
    for (const item of items) {
      this.addPathCandidateFromUnknown(out, item);
    }
  }

  private addPathCandidateFromUnknown(out: Set<string>, value: unknown): void {
    if (!value) return;

    if (typeof value === 'string') {
      this.addPathCandidate(out, value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) this.addPathCandidateFromUnknown(out, item);
      return;
    }

    if (typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;

    this.addPathCandidateFromUnknown(out, obj.uri);
    this.addPathCandidateFromUnknown(out, obj.path);
    this.addPathCandidateFromUnknown(out, obj.fsPath);
    this.addPathCandidateFromUnknown(out, obj.cwd);
    this.addPathCandidateFromUnknown(out, obj.filePath);
    this.addPathCandidateFromUnknown(out, obj.folderPath);
    this.addPathCandidateFromUnknown(out, obj.fileUri);
    this.addPathCandidateFromUnknown(out, obj.folderUri);
  }

  private addPathCandidate(out: Set<string>, rawPath: string | undefined): void {
    if (!rawPath) return;
    const normalized = this.normalizePath(rawPath);
    if (normalized) out.add(normalized);
  }

  private normalizePath(rawPath: string): string | null {
    const trimmed = rawPath.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('file://')) {
      try {
        const url = new URL(trimmed);
        let pathname = decodeURIComponent(url.pathname);
        if (process.platform === 'win32' && pathname.startsWith('/')) {
          pathname = pathname.slice(1);
        }
        return pathname || null;
      } catch {
        return null;
      }
    }

    if (trimmed.startsWith('~')) {
      const withoutTilde = trimmed.slice(1).replace(/^[/\\]+/, '');
      return join(homedir(), withoutTilde);
    }

    if (trimmed.startsWith('/')) return trimmed;
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;

    return null;
  }

  private toExistingDirectory(candidate: string): string | null {
    if (!existsSync(candidate)) return null;
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) return dirname(candidate);
    } catch {
      return null;
    }
    return null;
  }

  private findGitRoot(candidate: string): string | null {
    let current = this.toExistingDirectory(candidate);
    if (!current) return null;

    while (true) {
      if (existsSync(join(current, '.git'))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return null;
  }
}
