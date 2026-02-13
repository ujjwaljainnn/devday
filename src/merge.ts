import { basename } from 'node:path';
import type { Session, GitActivity, ProjectSummary, DayRecap, ToolName } from './types.js';
import { sumTokens, emptyTokenUsage } from './cost.js';

/**
 * Merge sessions and git activity into a DayRecap.
 */
export function buildDayRecap(
  date: string,
  sessions: Session[],
  gitActivities: GitActivity[],
): DayRecap {
  // Group sessions by project path
  const sessionsByProject = new Map<string, Session[]>();
  for (const session of sessions) {
    const key = session.projectPath ?? '__unknown__';
    if (!sessionsByProject.has(key)) {
      sessionsByProject.set(key, []);
    }
    sessionsByProject.get(key)!.push(session);
  }

  // Build a map of git activities by project path
  const gitByProject = new Map<string, GitActivity>();
  for (const git of gitActivities) {
    gitByProject.set(git.projectPath, git);
  }

  // Collect all unique project paths (from sessions and git)
  const allProjectPaths = new Set([
    ...sessionsByProject.keys(),
    ...gitByProject.keys(),
  ]);

  const projects: ProjectSummary[] = [];

  for (const projectPath of allProjectPaths) {
    const projectSessions = sessionsByProject.get(projectPath) ?? [];
    const git = gitByProject.get(projectPath) ?? null;

    if (projectSessions.length === 0 && (!git || git.commits.length === 0)) {
      continue;
    }

    const totalTokens = sumTokens(...projectSessions.map((s) => s.tokens));
    const totalCostUsd = projectSessions.reduce((sum, s) => sum + s.costUsd, 0);
    const totalDurationMs = projectSessions.reduce((sum, s) => sum + s.durationMs, 0);
    const totalMessages = projectSessions.reduce((sum, s) => sum + s.messageCount, 0);

    const toolsUsed = [...new Set(projectSessions.map((s) => s.tool))] as ToolName[];
    const modelsUsed = [...new Set(projectSessions.flatMap((s) => s.models))];
    const filesTouched = [...new Set(projectSessions.flatMap((s) => s.filesTouched))];

    const projectName =
      projectSessions[0]?.projectName ??
      git?.projectName ??
      basename(projectPath);

    projects.push({
      projectPath,
      projectName,
      sessions: projectSessions,
      git,
      totalSessions: projectSessions.length,
      totalMessages,
      totalTokens: totalTokens.total,
      totalCostUsd,
      totalDurationMs,
      toolsUsed,
      modelsUsed,
      filesTouched,
      aiSummary: null, // filled by summarizer
    });
  }

  // Sort projects by total cost (most expensive first)
  projects.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  // Global aggregates
  const totalSessions = projects.reduce((sum, p) => sum + p.totalSessions, 0);
  const totalMessages = projects.reduce((sum, p) => sum + p.totalMessages, 0);
  const globalTokens = sumTokens(...sessions.map((s) => s.tokens));
  const totalCostUsd = projects.reduce((sum, p) => sum + p.totalCostUsd, 0);
  const totalDurationMs = projects.reduce((sum, p) => sum + p.totalDurationMs, 0);
  const toolsUsed = [...new Set(projects.flatMap((p) => p.toolsUsed))] as ToolName[];

  return {
    date,
    projects,
    totalSessions,
    totalMessages,
    totalTokens: globalTokens.total,
    totalCostUsd,
    totalDurationMs,
    toolsUsed,
    standupMessage: null, // filled by summarizer
  };
}
