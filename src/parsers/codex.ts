import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { Parser, Session, TokenUsage } from '../types.js';
import { estimateCost, emptyTokenUsage } from '../cost.js';

interface ChatEvent {
  ts: number;
  role: 'User' | 'Assistant';
  text: string;
}

interface ToolEvent {
  ts: number;
  name: string;
  args: unknown;
}

interface TokenSnapshot {
  ts: number;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

export class CodexParser implements Parser {
  readonly name = 'codex' as const;
  private codexHome: string;
  private readonly userHome = homedir();

  constructor(codexHome: string) {
    this.codexHome = codexHome;
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(this.getSessionsDir());
  }

  async getSessions(date: string): Promise<Session[]> {
    const [year, month, day] = date.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day, 23, 59, 59, 999);
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();

    const files = this.findSessionFilesForDate(date);
    const sessions: Session[] = [];

    for (const filePath of files) {
      const session = filePath.endsWith('.jsonl')
        ? this.parseJsonlSession(filePath, dayStartMs, dayEndMs)
        : this.parseLegacyJsonSession(filePath, dayStartMs, dayEndMs);

      if (session) sessions.push(session);
    }

    return sessions;
  }

  private getSessionsDir(): string {
    return join(this.codexHome, 'sessions');
  }

  private findSessionFilesForDate(date: string): string[] {
    const sessionsDir = this.getSessionsDir();
    if (!existsSync(sessionsDir)) return [];

    const [year, month, day] = date.split('-');
    const files = new Set<string>();

    const dayDir = join(sessionsDir, year, month, day);
    if (existsSync(dayDir)) {
      for (const entry of readdirSync(dayDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.json')) continue;
        files.add(join(dayDir, entry.name));
      }
    }

    // Legacy sessions were stored directly under ~/.codex/sessions.
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith(`rollout-${date}`)) continue;
      if (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.json')) continue;
      files.add(join(sessionsDir, entry.name));
    }

    return [...files].sort();
  }

  private parseJsonlSession(filePath: string, dayStartMs: number, dayEndMs: number): Session | null {
    const lines = this.readJsonlLines(filePath);
    if (lines.length === 0) return null;

    let sessionId: string | null = null;
    let projectPath: string | null = null;

    const models = new Set<string>();
    const eventChats: ChatEvent[] = [];
    const legacyChats: ChatEvent[] = [];
    const toolEvents: ToolEvent[] = [];
    const tokenSnapshots: TokenSnapshot[] = [];

    let earliestTs = Number.POSITIVE_INFINITY;
    let latestTs = Number.NEGATIVE_INFINITY;

    for (const entry of lines) {
      const ts = this.extractTimestampMs(entry);
      if (ts !== null) {
        if (ts < earliestTs) earliestTs = ts;
        if (ts > latestTs) latestTs = ts;
      }

      const entryObj = this.asObject(entry);
      const entryType = this.asString(entryObj?.type);

      if (!sessionId) {
        const topLevelId = this.asString(entryObj?.id);
        if (topLevelId) sessionId = topLevelId;
      }

      if (entryType === 'session_meta') {
        const payload = this.asObject(entryObj?.payload);
        const id = this.asString(payload?.id);
        if (id) sessionId = id;

        const cwd = this.asString(payload?.cwd);
        if (cwd) projectPath = cwd;
      }

      if (entryType === 'turn_context') {
        const payload = this.asObject(entryObj?.payload);
        const model = this.asString(payload?.model);
        if (model) models.add(model);

        if (!projectPath) {
          const cwd = this.asString(payload?.cwd);
          if (cwd) projectPath = cwd;
        }
      }

      if (entryType === 'event_msg') {
        const payload = this.asObject(entryObj?.payload);
        const eventType = this.asString(payload?.type);

        if (eventType === 'user_message') {
          const message = this.asString(payload?.message);
          if (message && ts !== null) {
            eventChats.push({ ts, role: 'User', text: message });
            if (!projectPath) {
              const cwd = this.extractCwdFromText(message);
              if (cwd) projectPath = cwd;
            }
          }
        } else if (eventType === 'agent_message') {
          const message = this.asString(payload?.message);
          if (message && ts !== null) {
            eventChats.push({ ts, role: 'Assistant', text: message });
          }
        } else if (eventType === 'token_count') {
          const snap = this.extractTokenSnapshot(payload, ts);
          if (snap) tokenSnapshots.push(snap);
        }
      }

      if (entryType === 'response_item') {
        const payload = this.asObject(entryObj?.payload);
        const payloadType = this.asString(payload?.type);

        if (payloadType === 'function_call') {
          const name = this.asString(payload?.name);
          if (name && ts !== null) {
            toolEvents.push({
              ts,
              name,
              args: this.decodeToolArgs(payload?.arguments),
            });
          }
        }

        // Fallback for older codex formats with no event_msg stream.
        if (payloadType === 'message') {
          const roleRaw = this.asString(payload?.role);
          const role = roleRaw === 'user' ? 'User' : roleRaw === 'assistant' ? 'Assistant' : null;
          const text = this.extractMessageText(payload?.content);
          if (role && text && ts !== null) {
            legacyChats.push({ ts, role, text });
            if (!projectPath && role === 'User') {
              const cwd = this.extractCwdFromText(text);
              if (cwd) projectPath = cwd;
            }
          }
        }
      }

      // Very old JSONL format where message items are top-level entries.
      if (entryType === 'message') {
        const roleRaw = this.asString(entryObj?.role);
        const role = roleRaw === 'user' ? 'User' : roleRaw === 'assistant' ? 'Assistant' : null;
        const text = this.extractMessageText(entryObj?.content);
        const resolvedTs = ts ?? this.extractSessionTimestampMs(lines[0]) ?? dayStartMs;

        if (role && text) {
          legacyChats.push({ ts: resolvedTs, role, text });
          if (!projectPath && role === 'User') {
            const cwd = this.extractCwdFromText(text);
            if (cwd) projectPath = cwd;
          }
        }
      }

      if (entryType === 'function_call') {
        const name = this.asString(entryObj?.name);
        const resolvedTs = ts ?? this.extractSessionTimestampMs(lines[0]) ?? dayStartMs;
        if (name) {
          toolEvents.push({
            ts: resolvedTs,
            name,
            args: this.decodeToolArgs(entryObj?.arguments),
          });
        }
      }
    }

    if (earliestTs === Number.POSITIVE_INFINITY || latestTs === Number.NEGATIVE_INFINITY) {
      const headerTs = this.extractSessionTimestampMs(lines[0]);
      if (headerTs === null) return null;
      earliestTs = headerTs;
      latestTs = headerTs;
    }

    const overlapsDay = earliestTs <= dayEndMs && latestTs >= dayStartMs;
    if (!overlapsDay) return null;

    const chats = eventChats.length > 0 ? eventChats : legacyChats;
    const dayChats = chats.filter((m) => m.ts >= dayStartMs && m.ts <= dayEndMs);
    const dayTools = toolEvents.filter((t) => t.ts >= dayStartMs && t.ts <= dayEndMs);

    if (dayChats.length === 0 && dayTools.length === 0) return null;

    if (!projectPath) {
      projectPath = this.extractProjectPathFromToolCalls(dayTools) ?? this.extractProjectPathFromToolCalls(toolEvents);
    }

    const tokenUsage = this.computeDayTokenUsage(tokenSnapshots, dayStartMs, dayEndMs);
    const modelList = [...models];

    let costUsd = 0;
    if (tokenUsage.total > 0 && modelList.length > 0) {
      costUsd = estimateCost(modelList[0], tokenUsage);
    }

    const title = this.inferTitle(chats);
    const conversationDigest = this.buildConversationDigest(dayChats);

    const filesTouchedSet = new Set<string>();
    const toolSummariesSet = new Set<string>();
    for (const tool of dayTools) {
      const summary = this.summarizeToolCall(tool.name, tool.args);
      if (summary) toolSummariesSet.add(summary);

      for (const file of this.extractFilesFromToolCall(tool.args)) {
        filesTouchedSet.add(file);
      }
    }

    const timestamps = [
      ...dayChats.map((m) => m.ts),
      ...dayTools.map((t) => t.ts),
    ].sort((a, b) => a - b);

    const startedAtMs = timestamps[0] ?? Math.max(dayStartMs, earliestTs);
    const endedAtMs = timestamps[timestamps.length - 1] ?? Math.min(dayEndMs, latestTs);

    const durationMs = this.estimateDurationMs(timestamps);
    const userCount = dayChats.filter((m) => m.role === 'User').length;
    const assistantCount = dayChats.filter((m) => m.role === 'Assistant').length;

    const resolvedId = sessionId ?? basename(filePath).replace(/\.(jsonl|json)$/i, '');

    return {
      id: resolvedId,
      tool: 'codex',
      projectPath,
      projectName: projectPath ? basename(projectPath) : null,
      title,
      startedAt: new Date(startedAtMs),
      endedAt: new Date(endedAtMs),
      durationMs,
      messageCount: dayChats.length,
      userMessageCount: userCount,
      assistantMessageCount: assistantCount,
      summary: title,
      topics: title ? [title] : [],
      tokens: tokenUsage,
      costUsd,
      models: modelList,
      filesTouched: [...filesTouchedSet],
      conversationDigest,
      toolCallSummaries: [...toolSummariesSet],
    };
  }

  private parseLegacyJsonSession(filePath: string, dayStartMs: number, dayEndMs: number): Session | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }

    const root = this.asObject(parsed);
    const sessionObj = this.asObject(root?.session);
    const sessionTs = this.parseIsoMs(this.asString(sessionObj?.timestamp));
    if (sessionTs === null) return null;

    if (sessionTs < dayStartMs || sessionTs > dayEndMs) return null;

    const items = Array.isArray(root?.items) ? root.items : [];
    const chats: ChatEvent[] = [];
    const toolEvents: ToolEvent[] = [];

    let projectPath: string | null = null;

    for (const item of items) {
      const obj = this.asObject(item);
      const itemType = this.asString(obj?.type);

      if (itemType === 'message') {
        const roleRaw = this.asString(obj?.role);
        const role = roleRaw === 'user' ? 'User' : roleRaw === 'assistant' ? 'Assistant' : null;
        const text = this.extractMessageText(obj?.content);
        if (role && text) {
          chats.push({ ts: sessionTs, role, text });
          if (!projectPath && role === 'User') {
            const cwd = this.extractCwdFromText(text);
            if (cwd) projectPath = cwd;
          }
        }
      } else if (itemType === 'function_call') {
        const name = this.asString(obj?.name);
        if (name) {
          toolEvents.push({ ts: sessionTs, name, args: this.decodeToolArgs(obj?.arguments) });
        }
      }
    }

    if (chats.length === 0 && toolEvents.length === 0) return null;

    if (!projectPath) {
      projectPath = this.extractProjectPathFromToolCalls(toolEvents);
    }

    const title = this.inferTitle(chats);
    const conversationDigest = this.buildConversationDigest(chats);

    const filesTouchedSet = new Set<string>();
    const toolSummariesSet = new Set<string>();
    for (const tool of toolEvents) {
      const summary = this.summarizeToolCall(tool.name, tool.args);
      if (summary) toolSummariesSet.add(summary);
      for (const file of this.extractFilesFromToolCall(tool.args)) {
        filesTouchedSet.add(file);
      }
    }

    const userCount = chats.filter((m) => m.role === 'User').length;
    const assistantCount = chats.filter((m) => m.role === 'Assistant').length;
    const resolvedId = this.asString(sessionObj?.id) ?? basename(filePath).replace(/\.json$/i, '');

    return {
      id: resolvedId,
      tool: 'codex',
      projectPath,
      projectName: projectPath ? basename(projectPath) : null,
      title,
      startedAt: new Date(sessionTs),
      endedAt: new Date(sessionTs),
      durationMs: 0,
      messageCount: chats.length,
      userMessageCount: userCount,
      assistantMessageCount: assistantCount,
      summary: title,
      topics: title ? [title] : [],
      tokens: emptyTokenUsage(),
      costUsd: 0,
      models: [],
      filesTouched: [...filesTouchedSet],
      conversationDigest,
      toolCallSummaries: [...toolSummariesSet],
    };
  }

  private readJsonlLines(filePath: string): unknown[] {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }

    const out: unknown[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Skip malformed lines.
      }
    }
    return out;
  }

  private extractTimestampMs(entry: unknown): number | null {
    const obj = this.asObject(entry);
    const topLevelTs = this.parseIsoMs(this.asString(obj?.timestamp));
    if (topLevelTs !== null) return topLevelTs;

    const payload = this.asObject(obj?.payload);
    return this.parseIsoMs(this.asString(payload?.timestamp));
  }

  private extractSessionTimestampMs(firstEntry: unknown): number | null {
    const obj = this.asObject(firstEntry);
    if (!obj) return null;

    const ts = this.parseIsoMs(this.asString(obj.timestamp));
    if (ts !== null) return ts;

    const payload = this.asObject(obj.payload);
    if (payload) {
      const payloadTs = this.parseIsoMs(this.asString(payload.timestamp));
      if (payloadTs !== null) return payloadTs;
    }

    return null;
  }

  private extractTokenSnapshot(payload: Record<string, unknown> | null, ts: number | null): TokenSnapshot | null {
    if (ts === null || !payload) return null;

    const info = this.asObject(payload.info);
    const totals = this.asObject(info?.total_token_usage);
    if (!totals) return null;

    return {
      ts,
      input: this.asNumber(totals.input_tokens),
      cachedInput: this.asNumber(totals.cached_input_tokens),
      output: this.asNumber(totals.output_tokens),
      reasoning: this.asNumber(totals.reasoning_output_tokens),
    };
  }

  private computeDayTokenUsage(snapshots: TokenSnapshot[], dayStartMs: number, dayEndMs: number): TokenUsage {
    if (snapshots.length === 0) return emptyTokenUsage();

    const sorted = [...snapshots].sort((a, b) => a.ts - b.ts);
    const end = this.lastAtOrBefore(sorted, dayEndMs);
    if (!end) return emptyTokenUsage();

    const start = this.lastBefore(sorted, dayStartMs);

    const inputDelta = Math.max(0, end.input - (start?.input ?? 0));
    const cachedDelta = Math.max(0, end.cachedInput - (start?.cachedInput ?? 0));
    const output = Math.max(0, end.output - (start?.output ?? 0));
    const reasoning = Math.max(0, end.reasoning - (start?.reasoning ?? 0));

    const input = Math.max(0, inputDelta - cachedDelta);
    const cacheRead = cachedDelta;

    return {
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite: 0,
      total: input + output + reasoning + cacheRead,
    };
  }

  private lastAtOrBefore<T extends { ts: number }>(arr: T[], maxTs: number): T | null {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].ts <= maxTs) return arr[i];
    }
    return null;
  }

  private lastBefore<T extends { ts: number }>(arr: T[], minTs: number): T | null {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].ts < minTs) return arr[i];
    }
    return null;
  }

  private inferTitle(chats: ChatEvent[]): string | null {
    const userMessages = chats.filter((m) => m.role === 'User');
    if (userMessages.length === 0) return null;

    const meaningful = userMessages.find((m) => !this.isWrapperMessage(m.text)) ?? userMessages[0];
    const normalized = meaningful.text.replace(/\s+/g, ' ').trim();
    if (!normalized) return null;

    return normalized.length > 100 ? normalized.slice(0, 100) + '...' : normalized;
  }

  private isWrapperMessage(text: string): boolean {
    const trimmed = text.trim();
    return (
      trimmed.startsWith('# AGENTS.md instructions') ||
      trimmed.startsWith('<environment_context>') ||
      trimmed.startsWith('<permissions instructions>') ||
      trimmed.startsWith('<app-context>') ||
      trimmed.startsWith('<INSTRUCTIONS>') ||
      trimmed.startsWith('<user_instructions>')
    );
  }

  private buildConversationDigest(chats: ChatEvent[]): string {
    const parts: string[] = [];

    for (const chat of chats) {
      if (!chat.text.trim()) continue;
      if (chat.role === 'User' && this.isWrapperMessage(chat.text)) continue;

      const cleaned = chat.text.replace(/\s+/g, ' ').trim();
      const clipped = cleaned.length > 500 ? cleaned.slice(0, 500) + '...' : cleaned;
      parts.push(`[${chat.role}]: ${clipped}`);
    }

    let digest = parts.join('\n\n');
    if (digest.length > 4000) {
      digest = digest.slice(0, 4000) + '\n\n[...truncated]';
    }
    return digest;
  }

  private estimateDurationMs(timestamps: number[]): number {
    if (timestamps.length < 2) return 0;

    const MAX_GAP_MS = 5 * 60 * 1000;
    let durationMs = 0;

    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      if (gap > 0) durationMs += Math.min(gap, MAX_GAP_MS);
    }

    return durationMs;
  }

  private summarizeToolCall(name: string, args: unknown): string {
    const argsObj = this.asObject(args);

    const cmd = this.asString(argsObj?.cmd) ?? this.asString(argsObj?.command);
    if (cmd && (name.includes('exec') || name.includes('shell'))) {
      const clipped = cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd;
      return `bash: ${clipped}`;
    }

    const pathValue =
      this.asString(argsObj?.filePath) ??
      this.asString(argsObj?.path) ??
      this.asString(argsObj?.file);

    if (pathValue) {
      return `${name} ${this.shortenPath(pathValue)}`;
    }

    return name;
  }

  private extractFilesFromToolCall(args: unknown): string[] {
    const files = new Set<string>();

    const visit = (value: unknown, keyHint: string | null = null): void => {
      if (typeof value === 'string') {
        if (!keyHint || !this.isPathLikeKey(keyHint)) return;
        const normalized = this.normalizePath(value);
        if (normalized && this.isLikelyFilePath(normalized)) {
          files.add(normalized);
        }
        return;
      }

      if (Array.isArray(value)) {
        for (const item of value) visit(item, keyHint);
        return;
      }

      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        for (const [key, nested] of Object.entries(obj)) {
          if (key === 'cmd' || key === 'command') {
            if (typeof nested === 'string') {
              for (const candidate of this.extractPathCandidatesFromCommand(nested)) {
                const normalized = this.normalizePath(candidate);
                if (normalized && this.isLikelyFilePath(normalized)) {
                  files.add(normalized);
                }
              }
            }
            continue;
          }

          if (this.isPathLikeKey(key)) {
            if (typeof nested === 'string') {
              const normalized = this.normalizePath(nested);
              if (normalized && this.isLikelyFilePath(normalized)) {
                files.add(normalized);
              }
            }
          }

          visit(nested, key);
        }
      }
    };

    visit(args);
    return [...files];
  }

  private extractProjectPathFromToolCalls(toolCalls: ToolEvent[]): string | null {
    for (const call of toolCalls) {
      const args = this.asObject(call.args);
      const cwd = this.asString(args?.workdir) ?? this.asString(args?.cwd);
      if (cwd) return cwd;
    }

    return null;
  }

  private extractPathCandidatesFromCommand(cmd: string): string[] {
    // Ignore multiline and heredoc commands, which usually embed code and create path false positives.
    if (cmd.includes('\n') || cmd.includes('<<')) return [];

    const matches = cmd.match(/(?:~\/|\/|\.\/|\.\.\/)[^\s'"`;,)]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g) ?? [];
    return matches.filter((m) => !m.includes('*') && !m.includes('?') && !m.includes('|'));
  }

  private isLikelyFilePath(pathValue: string): boolean {
    if (pathValue.includes('://')) return false;
    if (pathValue.includes('\n')) return false;
    if (pathValue.includes(' ')) return false;
    if (pathValue.includes('*') || pathValue.includes('?') || pathValue.includes('|')) return false;
    if (pathValue.includes('\\b') || pathValue.includes('.test(')) return false;
    if (pathValue.startsWith('/^') || pathValue.startsWith('/\\')) return false;
    if (pathValue.endsWith('/')) return false;

    const base = basename(pathValue);
    if (!base) return false;
    if (base.startsWith('.')) return false;

    if (base.includes('.')) return true;
    return (
      base === 'Dockerfile' ||
      base === 'Makefile' ||
      base === 'README' ||
      base === 'README.md' ||
      base === 'AGENTS.md'
    );
  }

  private normalizePath(raw: string): string | null {
    const trimmed = raw.trim().replace(/^['"`]+|['"`]+$/g, '').replace(/[),;:.]+$/, '');
    if (!trimmed) return null;

    const lineSuffix = trimmed.match(/^(.*):(\d+)(?::\d+)?$/);
    const withoutLine = lineSuffix ? lineSuffix[1] : trimmed;

    if (withoutLine.startsWith('file://')) {
      const asPath = withoutLine.replace(/^file:\/\//, '');
      return asPath || null;
    }

    return withoutLine;
  }

  private isPathLikeKey(key: string): boolean {
    return (
      key === 'path' ||
      key === 'file' ||
      key === 'filePath' ||
      key === 'fullPath' ||
      key === 'uri' ||
      key === 'cwd' ||
      key === 'workdir'
    );
  }

  private shortenPath(pathValue: string): string {
    if (pathValue.startsWith(this.userHome)) {
      return `~${pathValue.slice(this.userHome.length)}`;
    }
    return pathValue;
  }

  private decodeToolArgs(args: unknown): unknown {
    if (typeof args !== 'string') return args;
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }

  private extractMessageText(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;

    const texts: string[] = [];
    for (const block of content) {
      const obj = this.asObject(block);
      if (!obj) continue;
      const text = this.asString(obj.text) ?? this.asString(obj.content);
      if (text) texts.push(text);
    }

    if (texts.length === 0) return null;
    return texts.join('\n');
  }

  private extractCwdFromText(text: string): string | null {
    const match = text.match(/<cwd>([^<]+)<\/cwd>/);
    return match ? match[1].trim() : null;
  }

  private parseIsoMs(value: string | null): number | null {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private asNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return 0;
  }
}
