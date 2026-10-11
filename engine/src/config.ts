import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();

/** Folders where agents keep user-wide settings. Anything inside is "global". */
export const AGENT_DIRS = ['.claude', '.codex', '.agents', '.cursor', '.gemini', '.windsurf', '.copilot', '.continue'];

/** Common places people keep code. Only the ones that exist are scanned. */
export const DEFAULT_CODE_DIRS = ['side-projects', 'projets', 'projects', 'Projects', 'code', 'Code', 'dev', 'Developer', 'src', 'repos', 'work', 'GitHub', 'Documents'];

export const EXCLUDED_DIRS = ['node_modules', '.git', 'vendor', '.venv', 'plugins', 'worktrees', 'cache', 'sessions', 'history', 'extensions', '.next', 'build', '.trash', 'vendor_imports', '.tmp', 'Library', '.Trash'];

const APP_SLUG = 'klosti';
/** The name before the Klosti rebrand. Existing folders under it keep working. */
const LEGACY_SLUG = 'agent-rulebook';

/** The Klosti folder in `parent`, or the pre-rebrand one when only that exists. */
function brandDir(parent: string): string {
  const current = join(parent, APP_SLUG);
  const legacy = join(parent, LEGACY_SLUG);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

const CONFIG_FILE = join(brandDir(join(HOME, '.config')), 'config.json');

export interface UserConfig {
  /** Extra folders to scan for projects, absolute or relative to the home folder. */
  roots?: string[];
  /** Replace the default code folders entirely. */
  replaceDefaultRoots?: boolean;
  /** Folder names to skip, added to the defaults. */
  exclude?: string[];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function readUserConfig(): UserConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new ConfigError('config must be a JSON object');
    const config = parsed as Record<string, unknown>;
    const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined);
    return { roots: strings(config.roots), exclude: strings(config.exclude), replaceDefaultRoots: config.replaceDefaultRoots === true };
  } catch (error) {
    throw new ConfigError(`Could not read ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface ResolvedConfig {
  codeRoots: string[];
  agentRoots: string[];
  excluded: string[];
  dataDir: string;
}

function defaultDataDir(): string {
  const fromEnv = process.env.KLOSTI_DATA ?? process.env.AGENT_RULEBOOK_DATA;
  if (fromEnv) return fromEnv;
  if (platform() === 'darwin') return brandDir(join(HOME, 'Library', 'Application Support'));
  if (platform() === 'win32') return brandDir(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'));
  return brandDir(process.env.XDG_DATA_HOME ?? join(HOME, '.local', 'share'));
}

export function resolveConfig(overrides: { roots?: string[]; dataDir?: string } = {}): ResolvedConfig {
  const user = readUserConfig();
  const expand = (p: string): string => (p.startsWith('~/') ? join(HOME, p.slice(2)) : p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) ? p : join(HOME, p));
  const defaults = user.replaceDefaultRoots ? [] : DEFAULT_CODE_DIRS.map(d => join(HOME, d));
  const wanted = overrides.roots?.map(expand) ?? [...defaults, ...(user.roots ?? []).map(expand)];
  return {
    codeRoots: [...new Set(wanted)].filter(p => existsSync(p)),
    agentRoots: AGENT_DIRS.map(d => join(HOME, d)).filter(p => existsSync(p)),
    excluded: [...new Set([...EXCLUDED_DIRS, ...(user.exclude ?? [])])],
    dataDir: overrides.dataDir ?? defaultDataDir(),
  };
}

export const MANAGED_CLAUDE_MD = platform() === 'darwin' ? '/Library/Application Support/ClaudeCode/CLAUDE.md' : platform() === 'linux' ? '/etc/claude-code/CLAUDE.md' : null;
