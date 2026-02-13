import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { GitActivity, GitCommit } from './types.js';

/**
 * Get git activity for a project directory on a specific date.
 */
export function getGitActivity(
  projectPath: string,
  date: string,
  authorFilter?: string | null,
): GitActivity | null {
  // Verify it's a git repo
  if (!existsSync(join(projectPath, '.git'))) return null;

  try {
    const args = [
      'log',
      `--after=${date}T00:00:00`,
      `--before=${date}T23:59:59`,
      '--format=%H|%h|%an|%aI|%s',
      '--no-merges',
    ];

    if (authorFilter) {
      args.push(`--author=${authorFilter}`);
    }

    const raw = execFileSync('git', args, {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();

    if (!raw) {
      return {
        projectPath,
        projectName: basename(projectPath),
        commits: [],
        totalFilesChanged: 0,
        totalInsertions: 0,
        totalDeletions: 0,
      };
    }

    const commitLines = raw.split('\n').filter(Boolean);
    const commits: GitCommit[] = [];

    for (const line of commitLines) {
      const [hash, shortHash, author, timestamp, ...messageParts] = line.split('|');
      const message = messageParts.join('|'); // message might contain |

      const stats = getCommitStats(projectPath, hash);

      commits.push({
        hash,
        shortHash,
        message,
        author,
        timestamp: new Date(timestamp),
        filesChanged: stats.filesChanged,
        insertions: stats.insertions,
        deletions: stats.deletions,
        files: stats.files,
      });
    }

    const totalFilesChanged = new Set(commits.flatMap((c) => c.files)).size;
    const totalInsertions = commits.reduce((sum, c) => sum + c.insertions, 0);
    const totalDeletions = commits.reduce((sum, c) => sum + c.deletions, 0);

    return {
      projectPath,
      projectName: basename(projectPath),
      commits,
      totalFilesChanged,
      totalInsertions,
      totalDeletions,
    };
  } catch {
    return null;
  }
}

function getCommitStats(
  projectPath: string,
  hash: string,
): { filesChanged: number; insertions: number; deletions: number; files: string[] } {
  try {
    const raw = execFileSync(
      'git',
      ['diff-tree', '--no-commit-id', '--numstat', '-r', hash],
      { cwd: projectPath, encoding: 'utf-8', timeout: 10_000 },
    ).trim();

    if (!raw) return { filesChanged: 0, insertions: 0, deletions: 0, files: [] };

    const lines = raw.split('\n').filter(Boolean);
    let insertions = 0;
    let deletions = 0;
    const files: string[] = [];

    for (const line of lines) {
      const [ins, del, file] = line.split('\t');
      if (ins !== '-') insertions += parseInt(ins, 10) || 0;
      if (del !== '-') deletions += parseInt(del, 10) || 0;
      if (file) files.push(file);
    }

    return { filesChanged: files.length, insertions, deletions, files };
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0, files: [] };
  }
}
