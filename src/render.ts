import chalk from 'chalk';
import Table from 'cli-table3';
import type { DayRecap, ProjectSummary } from './types.js';

export function renderRecap(recap: DayRecap, options: { standup?: boolean; json?: boolean }): void {
  if (options.json) {
    console.log(JSON.stringify(recap, null, 2));
    return;
  }

  if (options.standup) {
    renderStandup(recap);
    return;
  }

  renderFull(recap);
}

function renderStandup(recap: DayRecap): void {
  console.log('');
  console.log(chalk.bold.cyan(`  Standup for ${recap.date}`));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log('');

  if (recap.standupMessage) {
    const lines = recap.standupMessage.split('\n');
    for (const line of lines) {
      console.log(`  ${line}`);
    }
  } else {
    console.log(chalk.dim('  No activity to report.'));
  }

  console.log('');
}

function renderFull(recap: DayRecap): void {
  // Header
  console.log('');
  console.log(chalk.bold.cyan(`  devday - ${recap.date}`));
  console.log(chalk.dim('  ' + '═'.repeat(60)));
  console.log('');

  // Overview stats
  const overviewTable = new Table({
    chars: tableChars(),
    style: { head: ['cyan'], 'padding-left': 1, 'padding-right': 1 },
  });
  overviewTable.push(
    [
      { content: chalk.bold('Sessions'), hAlign: 'center' },
      { content: chalk.bold('Messages'), hAlign: 'center' },
      { content: chalk.bold('Tokens'), hAlign: 'center' },
      { content: chalk.bold('Cost'), hAlign: 'center' },
      { content: chalk.bold('Duration'), hAlign: 'center' },
      { content: chalk.bold('Tools'), hAlign: 'center' },
    ],
    [
      { content: String(recap.totalSessions), hAlign: 'center' },
      { content: String(recap.totalMessages), hAlign: 'center' },
      { content: formatTokens(recap.totalTokens), hAlign: 'center' },
      { content: formatCost(recap.totalCostUsd), hAlign: 'center' },
      { content: formatDuration(recap.totalDurationMs), hAlign: 'center' },
      { content: recap.toolsUsed.join(', '), hAlign: 'center' },
    ],
  );
  console.log(overviewTable.toString());
  console.log('');

  // Per-project details
  for (const project of recap.projects) {
    renderProject(project);
  }

  // Standup message at the bottom
  if (recap.standupMessage) {
    console.log(chalk.bold.yellow('  Standup'));
    console.log(chalk.dim('  ' + '─'.repeat(50)));
    const lines = recap.standupMessage.split('\n');
    for (const line of lines) {
      console.log(`  ${line}`);
    }
    console.log('');
  }
}

function renderProject(project: ProjectSummary): void {
  console.log(chalk.bold.green(`  ${project.projectName}`));
  console.log(chalk.dim(`  ${project.projectPath}`));
  console.log('');

  // Summary
  if (project.aiSummary) {
    console.log(`  ${project.aiSummary}`);
    console.log('');
  }

  // Sessions table
  if (project.sessions.length > 0) {
    const sessTable = new Table({
      chars: tableChars(),
      head: ['Session', 'Messages', 'Model', 'Cost', 'Duration'].map((h) => chalk.dim(h)),
      style: { head: [], 'padding-left': 1, 'padding-right': 1 },
      colWidths: [35, 10, 25, 10, 12],
      wordWrap: true,
    });

    for (const session of project.sessions) {
      sessTable.push([
        truncate(session.title ?? session.id, 33),
        String(session.messageCount),
        session.models.join(', ') || 'N/A',
        formatCost(session.costUsd),
        formatDuration(session.durationMs),
      ]);
    }

    console.log(sessTable.toString());
    console.log('');
  }

  // Git summary
  if (project.git && project.git.commits.length > 0) {
    console.log(chalk.dim('  Git'));

    for (const commit of project.git.commits.slice(0, 10)) {
      const sign = commit.insertions > 0 || commit.deletions > 0
        ? chalk.green(`+${commit.insertions}`) + chalk.red(`-${commit.deletions}`)
        : '';
      console.log(`  ${chalk.yellow(commit.shortHash)} ${commit.message} ${sign}`);
    }

    if (project.git.commits.length > 10) {
      console.log(chalk.dim(`  ... and ${project.git.commits.length - 10} more commits`));
    }
    console.log('');
  }

  console.log(chalk.dim('  ' + '─'.repeat(60)));
  console.log('');
}

// ── Formatting helpers ───────────────────────────────────────────

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function tableChars() {
  return {
    'top': '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
    'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
    'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
    'right': '│', 'right-mid': '┤', 'middle': '│',
  };
}
