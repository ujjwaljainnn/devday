import type { DayRecap, DevDayConfig, ProjectSummary } from './types.js';

const LLM_TIMEOUT_MS = 30_000;

/**
 * Generate LLM-powered summaries for the day recap.
 * Requires an API key (OPENAI_API_KEY or ANTHROPIC_API_KEY).
 * Returns the recap with summaries filled in, or null fields if LLM calls fail.
 */
export async function summarizeRecap(
  recap: DayRecap,
  config: DevDayConfig,
): Promise<DayRecap> {
  // Generate project-level summaries
  for (const project of recap.projects) {
    project.aiSummary = await summarizeProject(project, config);
  }

  // Generate standup message
  recap.standupMessage = await generateStandup(recap, config);

  return recap;
}

async function summarizeProject(
  project: ProjectSummary,
  config: DevDayConfig,
): Promise<string | null> {
  const prompt = buildProjectPrompt(project);

  if (config.preferredSummarizer === 'anthropic' && config.anthropicApiKey) {
    return callAnthropic(config.anthropicApiKey, prompt);
  }
  if (config.preferredSummarizer === 'openai' && config.openaiApiKey) {
    return callOpenAI(config.openaiApiKey, prompt);
  }
  return null;
}

async function generateStandup(
  recap: DayRecap,
  config: DevDayConfig,
): Promise<string | null> {
  const prompt = buildStandupPrompt(recap);

  if (config.preferredSummarizer === 'anthropic' && config.anthropicApiKey) {
    return callAnthropic(config.anthropicApiKey, prompt);
  }
  if (config.preferredSummarizer === 'openai' && config.openaiApiKey) {
    return callOpenAI(config.openaiApiKey, prompt);
  }
  return null;
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

function buildStandupPrompt(recap: DayRecap): string {
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

  return `Generate a standup message for what I accomplished today. Write in FIRST PERSON ("I built...", "I fixed...", "I worked on..."). Write 3-5 bullet points using past tense. Be specific about what was done. Group by project. Do not include cost, token, or session count information. Do not use markdown headers. Do not refer to "the developer" — this is my own standup.

${projectBlocks}

Write the standup as bullet points, starting each with "- ". First person, specific, concise.`;
}

// ── LLM API calls ────────────────────────────────────────────────

async function callAnthropic(apiKey: string, prompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

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

    clearTimeout(timeout);

    if (!res.ok) return null;

    const data: unknown = await res.json();
    const content = (data as Record<string, unknown>)?.content;
    if (!Array.isArray(content) || content.length === 0) return null;
    const first = content[0] as Record<string, unknown>;
    return typeof first?.text === 'string' ? first.text : null;
  } catch {
    return null;
  }
}

async function callOpenAI(apiKey: string, prompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) return null;

    const data: unknown = await res.json();
    const choices = (data as Record<string, unknown>)?.choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0] as Record<string, unknown>;
    const message = first?.message as Record<string, unknown> | undefined;
    return typeof message?.content === 'string' ? message.content : null;
  } catch {
    return null;
  }
}
