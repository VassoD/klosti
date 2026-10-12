import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './config.ts';
import type { Store } from './store.ts';

const CLAUDE_SESSIONS = join(HOME, '.claude', 'projects');
const FILE_TOOLS = new Map([['Write', 'wrote'], ['Edit', 'edited'], ['MultiEdit', 'edited'], ['NotebookEdit', 'edited']] as const);
const COMMAND_NAME = /<command-name>\/?([^<\s]+)<\/command-name>/;
/** Cheap substring checks so only the few relevant lines are parsed as JSON. */
const INTERESTING = ['"name":"Skill"', '<command-name>', '"name":"Write"', '"name":"Edit"', '"name":"MultiEdit"', '"name":"NotebookEdit"'];
const MAX_FILES_PER_USE = 50;
/** Claude Code's own slash commands. They are not skills, so they are skipped. */
const BUILT_IN_COMMANDS = new Set(['model', 'login', 'logout', 'mcp', 'clear', 'compact', 'config', 'cost', 'help', 'memory', 'permissions', 'resume', 'status', 'agents', 'hooks', 'ide', 'plugin', 'plugins', 'add-dir', 'bug', 'feedback', 'context', 'export', 'fast', 'effort', 'theme', 'vim', 'rewind', 'usage', 'upgrade', 'terminal-setup', 'statusline', 'privacy-settings', 'release-notes', 'install-github-app', 'output-style', 'todos', 'exit', 'artifacts', 'workflows', 'remote-control', 'doctor', 'init', 'auto-mode-setup', 'skills', 'tasks', 'stats', 'copy', 'branch', 'rename', 'sandbox', 'login-status']);
const RECENT_USES = 15;

export type FileAction = 'wrote' | 'edited';

export interface SkillUse {
  /** The skill as the session named it, for example "writing-plans" or "vercel:nextjs". */
  skill: string;
  at: string;
  /** The folder Claude Code was working in. */
  cwd: string | null;
  session: string;
  /** "claude" when the model picked the skill, "you" when it was typed as a slash command. */
  by: 'claude' | 'you';
  files: { path: string; action: FileAction }[];
}

export interface UsageCache {
  files: Record<string, { mtimeMs: number; size: number; uses: SkillUse[] }>;
}

export interface SkillUsage {
  count: number;
  lastAt: string;
  recent: SkillUse[];
}

interface LogLine {
  type?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  message?: { content?: unknown };
}

interface ToolUse { type: 'tool_use'; name: string; input: Record<string, unknown> }

const isToolUse = (value: unknown): value is ToolUse => typeof value === 'object' && value !== null && (value as ToolUse).type === 'tool_use' && typeof (value as ToolUse).name === 'string';

/**
 * Reads one session log. Only skill names, file paths, folders and times are kept, never message text.
 * Files written after a skill starts are credited to it until another skill starts in the same session.
 */
export function usesInLog(text: string): SkillUse[] {
  const uses: SkillUse[] = [];
  const current = new Map<string, SkillUse>();
  for (const line of text.split('\n')) {
    if (!INTERESTING.some(marker => line.includes(marker))) continue;
    let entry: LogLine;
    try { entry = JSON.parse(line) as LogLine; } catch { continue; }
    const session = entry.sessionId ?? '';
    const start = (skill: string, by: SkillUse['by']): void => {
      const use: SkillUse = { skill, at: entry.timestamp ?? '', cwd: entry.cwd ?? null, session, by, files: [] };
      uses.push(use);
      current.set(session, use);
    };
    const content = entry.message?.content;
    if (entry.type === 'user' && typeof content === 'string') {
      const typed = COMMAND_NAME.exec(content)?.[1];
      // Built-in commands like /model are not skills and must not take credit for later files.
      if (typed && !BUILT_IN_COMMANDS.has(typed)) start(typed, 'you');
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content.filter(isToolUse)) {
      if (block.name === 'Skill' && typeof block.input.skill === 'string') { start(block.input.skill, 'claude'); continue; }
      const action = FILE_TOOLS.get(block.name as 'Write');
      const path = block.input.file_path ?? block.input.notebook_path;
      const use = current.get(session);
      if (!action || typeof path !== 'string' || !use) continue;
      const seen = use.files.find(f => f.path === path);
      if (seen) { if (action === 'wrote') seen.action = 'wrote'; }
      else if (use.files.length < MAX_FILES_PER_USE) use.files.push({ path, action });
    }
  }
  return uses;
}

function sessionLogs(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.jsonl')) found.push(path);
    }
  };
  if (existsSync(CLAUDE_SESSIONS)) walk(CLAUDE_SESSIONS);
  return found;
}

/** Brings the cache up to date, re-reading only logs that changed since last time. */
export function refreshUsage(store: Store): UsageCache {
  const previous = store.usage();
  const next: UsageCache = { files: {} };
  let changed = false;
  for (const path of sessionLogs()) {
    let stat;
    try { stat = statSync(path); } catch { continue; }
    const known = previous.files[path];
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) { next.files[path] = known; continue; }
    try { next.files[path] = { mtimeMs: stat.mtimeMs, size: stat.size, uses: usesInLog(readFileSync(path, 'utf8')) }; changed = true; } catch { /* unreadable log */ }
  }
  if (changed || Object.keys(previous.files).length !== Object.keys(next.files).length) store.saveUsage(next);
  return next;
}

/** Uses grouped by the skill name the sessions used, newest first. */
export function summarizeUsage(cache: UsageCache): Record<string, SkillUsage> {
  const bySkill = new Map<string, SkillUse[]>();
  for (const { uses } of Object.values(cache.files)) for (const use of uses) bySkill.set(use.skill, [...(bySkill.get(use.skill) ?? []), use]);
  const out: Record<string, SkillUsage> = {};
  for (const [skill, uses] of bySkill) {
    const sorted = uses.sort((a, b) => b.at.localeCompare(a.at));
    out[skill] = { count: sorted.length, lastAt: sorted[0]?.at ?? '', recent: sorted.slice(0, RECENT_USES) };
  }
  return out;
}
