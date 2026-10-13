import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export const HOME = homedir();

/** Folders where agents keep user-wide settings. Anything inside is "global". */
export const AGENT_DIRS = ['.claude', '.codex', '.agents', '.cursor', '.gemini', '.vibe', '.windsurf', '.copilot', '.continue'];

/** Common places people keep code. Only the ones that exist are scanned. */
export const DEFAULT_CODE_DIRS = ['side-projects', 'projets', 'projects', 'Projects', 'code', 'Code', 'dev', 'Developer', 'src', 'repos', 'work', 'GitHub', 'Documents'];

export const EXCLUDED_DIRS = ['node_modules', '.git', 'vendor', '.venv', 'plugins', 'worktrees', 'cache', 'sessions', 'history', 'extensions', '.next', 'build', '.trash', 'vendor_imports', '.tmp', 'Library', '.Trash'];

export const KNOWN_AGENTS = ['Claude', 'Codex', 'Cursor', 'Gemini', 'Vibe'];

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
  /** Specific folders to skip, absolute or starting with ~/. */
  ignore?: string[];
  /** The agents the user works with. The app and the AI review leave the others out. Empty means all. */
  agents?: string[];
  /** Set once the user has chosen folders and agents on the welcome screen. */
  onboarded?: boolean;
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
    return { roots: strings(config.roots), exclude: strings(config.exclude), ignore: strings(config.ignore), agents: strings(config.agents), onboarded: typeof config.onboarded === 'boolean' ? config.onboarded : undefined, replaceDefaultRoots: config.replaceDefaultRoots === true };
  } catch (error) {
    throw new ConfigError(`Could not read ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface ResolvedConfig {
  codeRoots: string[];
  agentRoots: string[];
  excluded: string[];
  /** Absolute paths of folders the user chose not to scan. */
  ignored: string[];
  /** The agents the user works with. Empty means all. */
  agents: string[];
  /** False until the user has picked folders and agents, or has a config file from before onboarding existed. */
  onboarded: boolean;
  dataDir: string;
}

function defaultDataDir(): string {
  const fromEnv = process.env.KLOSTI_DATA ?? process.env.AGENT_RULEBOOK_DATA;
  if (fromEnv) return fromEnv;
  if (platform() === 'darwin') return brandDir(join(HOME, 'Library', 'Application Support'));
  if (platform() === 'win32') return brandDir(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'));
  return brandDir(process.env.XDG_DATA_HOME ?? join(HOME, '.local', 'share'));
}

export const expandPath = (p: string): string => (p.startsWith('~/') ? join(HOME, p.slice(2)) : p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) ? p : join(HOME, p));

export function resolveConfig(overrides: { roots?: string[]; dataDir?: string } = {}): ResolvedConfig {
  const user = readUserConfig();
  const expand = expandPath;
  const defaults = user.replaceDefaultRoots ? [] : DEFAULT_CODE_DIRS.map(d => join(HOME, d));
  const wanted = overrides.roots?.map(expand) ?? [...defaults, ...(user.roots ?? []).map(expand)];
  return {
    codeRoots: [...new Set(wanted)].filter(p => existsSync(p)),
    agentRoots: AGENT_DIRS.map(d => join(HOME, d)).filter(p => existsSync(p)),
    excluded: [...new Set([...EXCLUDED_DIRS, ...(user.exclude ?? [])])],
    ignored: [...new Set((user.ignore ?? []).map(expand))],
    agents: (user.agents ?? []).filter(a => KNOWN_AGENTS.includes(a)),
    onboarded: user.onboarded === true || (existsSync(CONFIG_FILE) && user.onboarded === undefined),
    dataDir: overrides.dataDir ?? defaultDataDir(),
  };
}

export const MANAGED_CLAUDE_MD = platform() === 'darwin' ? '/Library/Application Support/ClaudeCode/CLAUDE.md' : platform() === 'linux' ? '/etc/claude-code/CLAUDE.md' : null;

const tildePath = (p: string): string => (p.startsWith(`${HOME}/`) ? `~/${p.slice(HOME.length + 1)}` : p);

/** Merges these settings into the config file, keeping every other setting as it was. */
export function saveUserSettings(patch: Partial<Record<'roots' | 'ignore' | 'agents', string[]>> & { replaceDefaultRoots?: boolean; onboarded?: boolean }): void {
  const current: Record<string, unknown> = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown> : {};
  const next: Record<string, unknown> = { ...current, ...patch };
  for (const key of ['roots', 'ignore'] as const) if (patch[key]) next[key] = [...new Set(patch[key])].sort().map(tildePath);
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  const temp = `${CONFIG_FILE}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temp, CONFIG_FILE);
}

export const saveIgnored = (paths: string[]): void => saveUserSettings({ ignore: paths });

/** Code folders the settings can offer: the common ones that exist, plus any the user added. */
export const rootCandidates = (config: ResolvedConfig): string[] => [...new Set([...DEFAULT_CODE_DIRS.map(d => join(HOME, d)).filter(p => existsSync(p)), ...config.codeRoots])];

export const CONFIG_PATH = CONFIG_FILE;

/** Where each agent keeps its user-wide settings. A folder that exists means the agent is probably installed. */
export const AGENT_HOMES: Record<string, string> = { Claude: '.claude', Codex: '.codex', Cursor: '.cursor', Gemini: '.gemini', Vibe: '.vibe' };
/** How far below a code folder the welcome screen looks for projects, for layouts like code/client/repo. */
const PROJECT_SEARCH_DEPTH = 4;
/** Files or folders that mark a project as having agent instructions. */
const PROJECT_MARKERS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.claude', '.agents', '.cursor', '.cursorrules', '.codex', '.vibe'];

export interface OnboardingChoices {
  agents: { name: string; found: boolean }[];
  folders: { path: string; projects: string[] }[];
  agentRoots: string[];
}

/** A quick look, without a full scan, so the welcome screen can suggest agents and folders. */
export function onboardingChoices(config: ResolvedConfig): OnboardingChoices {
  const projectsIn = (root: string): string[] => {
    const found: string[] = [];
    const walk = (dir: string, depth: number): void => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || EXCLUDED_DIRS.includes(entry.name)) continue;
        const child = join(dir, entry.name);
        // A project ends the search on its branch; otherwise look deeper, like the scanner does.
        if (PROJECT_MARKERS.some(m => existsSync(join(child, m)))) found.push(child);
        else if (depth < PROJECT_SEARCH_DEPTH) walk(child, depth + 1);
      }
    };
    walk(root, 1);
    return found.sort((a, b) => a.localeCompare(b));
  };
  return {
    agents: KNOWN_AGENTS.map(name => ({ name, found: existsSync(join(HOME, AGENT_HOMES[name] ?? '')) })),
    folders: rootCandidates(config).map(path => ({ path, projects: projectsIn(path) })),
    agentRoots: config.agentRoots,
  };
}
