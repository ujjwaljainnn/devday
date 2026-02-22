import type { DayRecap, DevDayConfig, ProjectSummary } from './types.js';

const LLM_TIMEOUT_MS = 30_000;

// ── Error types ──────────────────────────────────────────────────

type LlmResult =
  | { ok: true; text: string }
  | { ok: false; error: string; retriable: boolean };

/** Optional logger — when provided, debug/warning messages are emitted. */
export interface SummarizeLogger {
  debug: (msg: string) => void;
  warn: (msg: string) => void;
}

const noopLogger: SummarizeLogger = {
  debug: () => {},
  warn: () => {},
};

// ── Public API ───────────────────────────────────────────────────

/**
 * Generate LLM-powered summaries for the day recap.
 * Requires an API key (CONCENTRATE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY).
 * Returns the recap with summaries filled in, or null fields if LLM calls fail.
 */
export async function summarizeRecap(
  recap: DayRecap,
  config: DevDayConfig,
  logger: SummarizeLogger = noopLogger,
): Promise<DayRecap> {
  const provider = config.preferredSummarizer;
  let hasFailure = false;

  // Generate project-level summaries
  for (const project of recap.projects) {
    const result = await summarizeProject(project, config, logger);
    if (result === null) hasFailure = true;
    project.aiSummary = result;
  }

  // Only attempt standup if at least some project summaries succeeded.
  // If every project failed, the same underlying issue (bad key, rate limit, etc.)
  // will just fail again on the standup call.
  if (hasFailure && recap.projects.every((p) => p.aiSummary === null)) {
    logger.warn(`all project summaries failed via ${provider}, skipping standup`);
    return recap;
  }

  const standupResult = await generateStandup(recap, config, logger);
  recap.standupMessage = standupResult;

  return recap;
}

// ── Summarize helpers ────────────────────────────────────────────

async function summarizeProject(
  project: ProjectSummary,
  config: DevDayConfig,
  logger: SummarizeLogger,
): Promise<string | null> {
  const prompt = buildProjectPrompt(project);
  const result = await callLlm(config, prompt, logger);

  if (!result.ok) {
    logger.warn(`summary failed for "${project.projectName}": ${result.error}`);
    return null;
  }
  return result.text;
}

async function generateStandup(
  recap: DayRecap,
  config: DevDayConfig,
  logger: SummarizeLogger,
): Promise<string | null> {
  const prompt = buildStandupPrompt(recap, config);
  const result = await callLlm(config, prompt, logger);

  if (!result.ok) {
    logger.warn(`standup generation failed: ${result.error}`);
    return null;
  }
  return result.text;
}

/**
 * Route to the correct LLM backend based on config.
 */
async function callLlm(
  config: DevDayConfig,
  prompt: string,
  logger: SummarizeLogger,
): Promise<LlmResult> {
  const linearMcpTool = getLinearMcpTool(config);

  if (config.preferredSummarizer === 'concentrate' && config.concentrateApiKey) {
    return callConcentrate(config.concentrateApiKey, prompt, linearMcpTool, logger);
  }
  if (config.preferredSummarizer === 'anthropic' && config.anthropicApiKey) {
    return callAnthropic(config.anthropicApiKey, prompt, logger);
  }
  if (config.preferredSummarizer === 'openai' && config.openaiApiKey) {
    return callOpenAI(config.openaiApiKey, prompt, linearMcpTool, logger);
  }
  return { ok: false, error: 'no API key configured', retriable: false };
}

// ── Prompts ──────────────────────────────────────────────────────

function buildProjectPrompt(project: ProjectSummary): string {
  const conversationContext = project.sessions
    .map((s) => {
      let block = `### Session: "${s.title ?? 'Untitled'}" (${s.messageCount} messages, ${Math.round(s.durationMs / 60_000)}min)\n`;
      if (s.conversationDigest) {
        block += s.conversationDigest;
      }
      if (s.toolCallSummaries.length > 0) {
        const dedupedTools = [...new Set(s.toolCallSummaries)].slice(0, 15);
        block += `\nTool calls: ${dedupedTools.join(', ')}`;
      }
      return block;
    })
    .join('\n\n');

  const gitLines = project.git?.commits
    .map((c) => `- ${c.shortHash}: ${c.message} (+${c.insertions}/-${c.deletions})`)
    .join('\n') ?? 'No git commits';

  return `You are writing a daily recap for a developer, summarizing their coding sessions. Write in FIRST PERSON ("I built...", "I fixed...", "I worked on..."). Read the conversation content and write a concise 2-3 sentence summary of what was accomplished. Focus on the specific work done (features built, bugs fixed, refactoring, debugging, etc.), not the tools or process.

Project: ${project.projectName}
Duration: ${Math.round(project.totalDurationMs / 60_000)} minutes across ${project.totalSessions} session(s)

--- Conversation Content ---
${conversationContext}

--- Git Commits ---
${gitLines}

Write a concise summary (2-3 sentences) in first person. Be specific about what was built/fixed/changed. Do not mention AI tools, session counts, or refer to "the developer".`;
}

function providerSupportsMcp(provider: DevDayConfig['preferredSummarizer']): boolean {
  return provider === 'concentrate' || provider === 'openai';
}

function hasLinearMcp(config: DevDayConfig): boolean {
  return providerSupportsMcp(config.preferredSummarizer) && !!config.linearMcpServerUrl;
}

function getPreviousDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function buildLinearMcpPromptBlock(recapDate: string): string {
  const previousDate = getPreviousDate(recapDate);
  return `
You have access to a Linear MCP server tool labeled "linear". Before writing the final answer, query Linear and pull:
- tickets created on ${recapDate}
- tickets closed/completed on ${recapDate} (if empty, check ${previousDate})
- tickets currently assigned to me
- tickets currently in active/in-progress states

Use the ticket data to enrich the standup with concrete ticket IDs/titles when possible. After the accomplishment bullets, add:
- one bullet that starts with "Things I'm working on:"
- one bullet that starts with "Things I'm planning to work on:"
If Linear data is unavailable or empty, omit these two bullets.`;
}

function buildStandupPrompt(recap: DayRecap, config: DevDayConfig): string {
  const projectBlocks = recap.projects
    .map((p) => {
      let block = `## ${p.projectName}\n`;

      if (p.aiSummary) {
        block += `Summary: ${p.aiSummary}\n`;
      }

      for (const session of p.sessions) {
        if (session.conversationDigest) {
          block += `\nSession "${session.title ?? 'Untitled'}":\n`;
          block += session.conversationDigest.slice(0, 500);
        }
      }

      if (p.git && p.git.commits.length > 0) {
        block += `\nGit: ${p.git.commits.map((c) => c.message).join('; ')}`;
      }
      return block;
    })
    .join('\n\n');
  const linearMcpInstructions = hasLinearMcp(config) ? buildLinearMcpPromptBlock(recap.date) : '';

  return `Generate a standup message for what I accomplished today. Write in FIRST PERSON ("I built...", "I fixed...", "I worked on..."). Write 3-5 bullet points using past tense. Be specific about what was done. Group by project. Do not include cost, token, or session count information. Do not use markdown headers. Do not refer to "the developer" — this is my own standup.

${projectBlocks}
${linearMcpInstructions}

Write the standup as bullet points, starting each with "- ". First person, specific, concise.`;
}

// ── HTTP error helpers ───────────────────────────────────────────

function describeHttpError(status: number, body: string, provider: string): LlmResult {
  const truncatedBody = body.length > 200 ? body.slice(0, 200) + '...' : body;

  switch (status) {
    case 401:
    case 403:
      return { ok: false, error: `${provider}: invalid API key (${status})`, retriable: false };
    case 429:
      return { ok: false, error: `${provider}: rate limited (429) — try again shortly`, retriable: true };
    case 402:
      return { ok: false, error: `${provider}: insufficient credits (402)`, retriable: false };
    case 400:
      return { ok: false, error: `${provider}: bad request (400): ${truncatedBody}`, retriable: false };
    default:
      if (status >= 500) {
        return { ok: false, error: `${provider}: server error (${status}): ${truncatedBody}`, retriable: true };
      }
      return { ok: false, error: `${provider}: HTTP ${status}: ${truncatedBody}`, retriable: false };
  }
}

function describeException(err: unknown, provider: string): LlmResult {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return { ok: false, error: `${provider}: request timed out after ${LLM_TIMEOUT_MS / 1000}s`, retriable: true };
  }
  if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('network'))) {
    return { ok: false, error: `${provider}: network error — ${err.message}`, retriable: true };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, error: `${provider}: ${msg}`, retriable: false };
}

// ── LLM API calls ────────────────────────────────────────────────

function getLinearMcpTool(config: DevDayConfig): Record<string, unknown> | null {
  if (!providerSupportsMcp(config.preferredSummarizer) || !config.linearMcpServerUrl) {
    return null;
  }

  const tool: Record<string, unknown> = {
    type: 'mcp',
    server_label: 'linear',
    server_url: config.linearMcpServerUrl,
    require_approval: 'never',
  };

  if (config.linearMcpAuthToken) {
    tool.headers = { Authorization: `Bearer ${config.linearMcpAuthToken}` };
  }

  return tool;
}

function extractResponseText(data: unknown, provider: string): LlmResult {
  const response = data as Record<string, unknown>;

  if (typeof response.output_text === 'string' && response.output_text.trim().length > 0) {
    return { ok: true, text: response.output_text.trim() };
  }

  const output = response.output;
  if (!Array.isArray(output) || output.length === 0) {
    return { ok: false, error: `${provider}: empty output array in response`, retriable: false };
  }

  const texts: string[] = [];
  for (const item of output) {
    const row = item as Record<string, unknown>;
    if (row.type !== 'message') continue;

    const content = row.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const part = block as Record<string, unknown>;
      if (typeof part.text === 'string' && part.text.trim().length > 0) {
        texts.push(part.text.trim());
      }
    }
  }

  if (texts.length === 0) {
    const outputTypes = output
      .map((item) => String((item as Record<string, unknown>)?.type ?? 'unknown'))
      .join(', ');
    return { ok: false, error: `${provider}: no text output found (got types: ${outputTypes})`, retriable: false };
  }

  return { ok: true, text: texts.join('\n\n') };
}

async function callConcentrate(
  apiKey: string,
  prompt: string,
  linearMcpTool: Record<string, unknown> | null,
  logger: SummarizeLogger,
): Promise<LlmResult> {
  const provider = 'concentrate';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    logger.debug(
      `${provider}: calling gpt-5-mini (reasoning: low${linearMcpTool ? ', linear MCP enabled' : ''})`,
    );

    const body: Record<string, unknown> = {
      model: 'gpt-5-mini',
      max_output_tokens: 600,
      reasoning: { effort: 'low' },
      input: prompt,
    };
    if (linearMcpTool) {
      body.tools = [linearMcpTool];
      body.tool_choice = 'auto';
    }

    const res = await fetch('https://api.concentrate.ai/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return describeHttpError(res.status, body, provider);
    }

    const data: unknown = await res.json();
    const status = (data as Record<string, unknown>)?.status;

    // Check for API-level incomplete/failed status
    if (status === 'failed') {
      const error = (data as Record<string, unknown>)?.error as Record<string, unknown> | undefined;
      const msg = typeof error?.message === 'string' ? error.message : 'unknown error';
      return { ok: false, error: `${provider}: response failed — ${msg}`, retriable: true };
    }
    if (status === 'incomplete') {
      const details = (data as Record<string, unknown>)?.incomplete_details as Record<string, unknown> | undefined;
      const reason = typeof details?.reason === 'string' ? details.reason : 'unknown';
      return { ok: false, error: `${provider}: response incomplete — ${reason}`, retriable: false };
    }

    const textResult = extractResponseText(data, provider);
    if (!textResult.ok) return textResult;

    logger.debug(`${provider}: success`);
    return textResult;
  } catch (err) {
    return describeException(err, provider);
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropic(apiKey: string, prompt: string, logger: SummarizeLogger): Promise<LlmResult> {
  const provider = 'anthropic';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    logger.debug(`${provider}: calling claude-3-5-haiku`);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return describeHttpError(res.status, body, provider);
    }

    const data: unknown = await res.json();
    const content = (data as Record<string, unknown>)?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return { ok: false, error: `${provider}: empty content array in response`, retriable: false };
    }

    const first = content[0] as Record<string, unknown>;
    if (typeof first?.text !== 'string') {
      return { ok: false, error: `${provider}: first content block has no text (type: ${first?.type})`, retriable: false };
    }

    logger.debug(`${provider}: success`);
    return { ok: true, text: first.text };
  } catch (err) {
    return describeException(err, provider);
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAI(
  apiKey: string,
  prompt: string,
  linearMcpTool: Record<string, unknown> | null,
  logger: SummarizeLogger,
): Promise<LlmResult> {
  const provider = 'openai';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    logger.debug(`${provider}: calling gpt-4o-mini${linearMcpTool ? ' with linear MCP' : ''}`);

    const body: Record<string, unknown> = {
      model: 'gpt-4o-mini',
      max_output_tokens: 400,
      input: prompt,
    };
    if (linearMcpTool) {
      body.tools = [linearMcpTool];
      body.tool_choice = 'auto';
    }

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return describeHttpError(res.status, body, provider);
    }

    const data: unknown = await res.json();
    const textResult = extractResponseText(data, provider);
    if (!textResult.ok) return textResult;

    logger.debug(`${provider}: success`);
    return textResult;
  } catch (err) {
    return describeException(err, provider);
  } finally {
    clearTimeout(timeout);
  }
}
