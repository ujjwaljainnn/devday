import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { format, subDays } from 'date-fns';
import { homedir } from 'node:os';
import { loadConfig } from './config.js';
import { OpenCodeParser } from './parsers/opencode.js';
import { ClaudeCodeParser } from './parsers/claude-code.js';
import { CursorParser } from './parsers/cursor.js';
import { getGitActivity } from './git.js';
import { buildDayRecap } from './merge.js';
import { summarizeRecap, type SummarizeLogger } from './summarize.js';
import { renderRecap } from './render.js';
import type { Session, GitActivity, Parser } from './types.js';

let verbose = false;

function debug(msg: string): void {
  if (verbose) console.error(chalk.dim(`  [debug] ${msg}`));
}

/**
 * Resolve date string: supports YYYY-MM-DD, "today", "yesterday"
 */
function resolveDate(input: string | undefined): string {
  if (!input) return format(new Date(), 'yyyy-MM-dd');
  const lower = input.toLowerCase();
  if (lower === 'today') return format(new Date(), 'yyyy-MM-dd');
  if (lower === 'yesterday') return format(subDays(new Date(), 1), 'yyyy-MM-dd');
  return input;
}

const program = new Command();

program
  .name('devday')
  .description('End-of-day recap for AI-assisted coding sessions')
  .version('0.1.0')
  .option('-d, --date <date>', 'date: YYYY-MM-DD, "today", or "yesterday" (default: today)')
  .option('-s, --standup', 'output a short standup-ready summary')
  .option('-j, --json', 'output raw JSON')
  .option('-v, --verbose', 'show debug output')
  .option('--no-git', 'skip git log integration')
  .option('--no-summarize', 'skip LLM summarization')
  .addHelpText('after', `
Examples:
  $ devday                    today's recap
  $ devday -d yesterday       yesterday's recap
  $ devday -d 2026-02-10      specific date
  $ devday --standup          short standup format
  $ devday --json             machine-readable output
  $ devday -d yesterday -s    yesterday's standup

Environment variables:
  CONCENTRATE_API_KEY         enables AI-powered summaries via Concentrate AI
  OPENAI_API_KEY              enables AI-powered summaries via OpenAI
  ANTHROPIC_API_KEY           enables AI-powered summaries via Anthropic

Supported tools:
  opencode                    ~/.local/share/opencode/storage/
  claude code                 ~/.claude/
  cursor                      ~/Library/.../state.vscdb
`)
  .action(async (opts) => {
    verbose = opts.verbose ?? false;
    const date = resolveDate(opts.date);
    const config = loadConfig();

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error(chalk.red(`Invalid date format: "${opts.date}". Use YYYY-MM-DD, "today", or "yesterday".`));
      process.exit(1);
    }

    const isJson = opts.json ?? false;

    // ── First-run banner (skip for JSON output) ───────────────
    if (!isJson) {
      printBanner(config, date);
    }

    const spinner = ora({ text: 'Scanning sessions...', color: 'cyan' });
    if (!verbose && !isJson) spinner.start();

    try {
      // ── Initialize parsers ──────────────────────────────────
      const parsers: Parser[] = [];

      if (config.enabledTools.includes('opencode') && config.paths.opencodeStorage) {
        parsers.push(new OpenCodeParser(config.paths.opencodeStorage));
        debug(`opencode storage: ${config.paths.opencodeStorage}`);
      }

      if (config.enabledTools.includes('claude-code') && config.paths.claudeCodeHome) {
        parsers.push(new ClaudeCodeParser(config.paths.claudeCodeHome));
        debug(`claude code home: ${config.paths.claudeCodeHome}`);
      }

      if (config.enabledTools.includes('cursor') && config.paths.cursorStateDb) {
        parsers.push(new CursorParser(config.paths.cursorStateDb));
        debug(`cursor db: ${config.paths.cursorStateDb}`);
      }

      if (parsers.length === 0) {
        spinner.stop();
        printNoToolsMessage();
        return;
      }

      // ── Collect sessions ────────────────────────────────────
      const allSessions: Session[] = [];
      for (const parser of parsers) {
        if (await parser.isAvailable()) {
          spinner.text = `Reading ${parser.name} sessions...`;
          debug(`scanning ${parser.name}...`);
          const sessions = await parser.getSessions(date);
          debug(`  found ${sessions.length} session(s) from ${parser.name}`);
          allSessions.push(...sessions);
        } else {
          debug(`${parser.name} not available, skipping`);
        }
      }

      // ── Early exit if nothing found ─────────────────────────
      if (allSessions.length === 0) {
        spinner.stop();
        if (!isJson) {
          console.log(chalk.dim(`  No sessions found for ${date}.`));
          if (date === format(new Date(), 'yyyy-MM-dd')) {
            console.log(chalk.dim('  Try: devday -d yesterday'));
          }
          console.log('');
        } else {
          console.log(JSON.stringify({ date, projects: [], totalSessions: 0 }, null, 2));
        }
        return;
      }

      spinner.text = `Found ${allSessions.length} session(s). Checking git...`;

      // ── Collect git activity ────────────────────────────────
      const gitActivities: GitActivity[] = [];
      if (opts.git !== false) {
        const projectPaths = [...new Set(allSessions.map((s) => s.projectPath).filter(Boolean))] as string[];
        for (const projectPath of projectPaths) {
          debug(`checking git in ${projectPath}`);
          const git = getGitActivity(projectPath, date, config.gitAuthorFilter);
          if (git) {
            debug(`  ${git.commits.length} commit(s)`);
            gitActivities.push(git);
          }
        }
      }

      // ── Merge ───────────────────────────────────────────────
      let recap = buildDayRecap(date, allSessions, gitActivities);

      // ── Summarize (only if API key is available) ──────────
      const hasApiKey = config.preferredSummarizer !== 'none';
      const summaryWarnings: string[] = [];

      if (hasApiKey && opts.summarize !== false) {
        debug(`using ${config.preferredSummarizer} for summarization`);
        spinner.text = 'Generating summary...';

        const logger: SummarizeLogger = {
          debug,
          warn: (msg: string) => {
            debug(`[warn] ${msg}`);
            summaryWarnings.push(msg);
          },
        };
        recap = await summarizeRecap(recap, config, logger);
      } else if (!hasApiKey) {
        debug('no API key set, skipping summarization');
      }

      spinner.stop();

      // ── Standup without API key → exit early ────────────────
      if (opts.standup && !hasApiKey) {
        console.log('');
        console.log(chalk.yellow('  Standup requires an API key to generate summaries.'));
        console.log('');
        console.log('  Run:');
        console.log(chalk.cyan('    export CONCENTRATE_API_KEY=sk-cn-...'));
        console.log('');
        console.log('  Then try again:');
        console.log(chalk.cyan('    devday --standup'));
        console.log('');
        return;
      }

      // ── Render ──────────────────────────────────────────────
      renderRecap(recap, { standup: opts.standup, json: isJson });

      // Show summary warnings (auth errors, timeouts, etc.)
      if (summaryWarnings.length > 0 && !isJson) {
        console.log('');
        console.log(chalk.yellow('  Summary warnings:'));
        // Deduplicate identical errors (e.g. same auth error for every project)
        const unique = [...new Set(summaryWarnings)];
        for (const w of unique) {
          console.log(chalk.dim(`    • ${w}`));
        }
        console.log('');
      }

      // Prompt to set API key if not configured
      if (!hasApiKey && !isJson) {
        console.log('');
        console.log('  To generate AI-powered summaries and standup messages:');
        console.log(chalk.cyan('    export CONCENTRATE_API_KEY=sk-cn-...'));
        console.log('');
      }
    } catch (error) {
      spinner.stop();
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      if (verbose && error instanceof Error && error.stack) {
        console.error(chalk.dim(error.stack));
      }
      process.exit(1);
    }
  });

program.parse();

// ── Helper functions ──────────────────────────────────────────────

function printBanner(
  config: ReturnType<typeof loadConfig>,
  date: string,
): void {
  console.log('');
  console.log(chalk.bold.cyan('  devday') + chalk.dim(' v0.1.0'));
  console.log('');

  // Tools detected
  const tools: string[] = [];
  if (config.paths.opencodeStorage) tools.push(chalk.green('opencode'));
  if (config.paths.claudeCodeHome) tools.push(chalk.green('claude code'));
  if (config.paths.cursorStateDb) tools.push(chalk.green('cursor'));
  if (tools.length > 0) {
    console.log(chalk.dim('  Tools: ') + tools.join(', '));
  } else {
    console.log(chalk.dim('  Tools: ') + chalk.yellow('none detected'));
  }

  // Summarizer status
  if (config.preferredSummarizer !== 'none') {
    console.log(chalk.dim('  Summaries: ') + chalk.green(config.preferredSummarizer));
  } else {
    console.log(chalk.dim('  Summaries: ') + chalk.yellow('not configured'));
  }

  console.log(chalk.dim(`  Date: ${date}`));
  console.log('');
}

function printNoToolsMessage(): void {
  const home = homedir();
  console.log('');
  console.log(chalk.yellow('  No AI coding tools detected.'));
  console.log('');
  console.log('  devday scans local conversations from these tools:');
  console.log('');
  console.log(`    ${chalk.cyan('opencode')}      ${chalk.dim(home + '/.local/share/opencode/storage/')}`);
    console.log(`    ${chalk.cyan('claude code')}    ${chalk.dim(home + '/.claude/')}`);
    console.log(`    ${chalk.cyan('cursor')}          ${chalk.dim('~/Library/.../state.vscdb')}`);
  console.log('');
  console.log('  Install a supported tool and start a coding session,');
  console.log('  then run ' + chalk.cyan('devday') + ' again.');
  console.log('');
}
