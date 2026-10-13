import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { AGENT_DIRS, expandPath, HOME, MANAGED_CLAUDE_MD, type ResolvedConfig } from './config.ts';
import type { Agent, ChangeSummary, Extra, Extras, FileRecord, HistoryEntry, HookExtra, InstalledPlugin, Inventory, McpExtra, McpScope, MarkdownExtra, MemoryIndex, RuleFamily, Scope, SkillSource } from './types.ts';

const RULE_NAMES = new Set(['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', 'copilot-instructions.md']);
const RULE_DIRS = ['/.claude/rules/', '/.cursor/rules/', '/.windsurf/rules/'];
const HOME_RULE_FILES = ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md'];
const SKILL_NAME = 'SKILL.md';
const SKILLS_LOCK = 'skills-lock.json';
const HISTORY_LIMIT = 200;
const COMMAND_PREVIEW_CHARS = 4000;
const HOOK_COMMAND_CHARS = 280;
const IMPORT_ROUNDS = 4;
const CLAUDE_JSON = join(HOME, '.claude.json');
const CLAUDE_INSTALLED_PLUGINS = join(HOME, '.claude', 'plugins', 'installed_plugins.json');
const CLAUDE_MARKETPLACES = join(HOME, '.claude', 'plugins', 'known_marketplaces.json');
const CLAUDE_SETTINGS = join(HOME, '.claude', 'settings.json');
const CODEX_CONFIG = join(HOME, '.codex', 'config.toml');
const CODEX_PLUGIN_CACHE = join(HOME, '.codex', 'plugins', 'cache');
const VIBE_DIR = join(HOME, '.vibe');
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*)=\S+/gi;
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g;
const PACKAGE_ARG = /^@?[a-z0-9][\w.-]*(\/[\w.-]+)?(@[\w.-]+)?$/i;
const SYSTEM_SKILL_MARKERS = ['/.codex/skills/.system/', '/.cursor/skills-cursor/', '/builtin/skills/'];
const LIMITS = [
  'Finding a file does not prove a running session loaded it.',
  'Account-level instructions and connectors (claude.ai, ChatGPT), conversation prompts and managed settings are not fully inventoried.',
  'Plugin parts come from enabled Claude Code and Codex plugins only.',
  'MCP entries keep only the server name, transport and host. Environment variables, headers and arguments are never copied.',
  'Hook commands are shown with anything that looks like a credential masked.',
  'Imports: only standalone @file references, up to four rounds.',
  'Excluded directories and projects outside scanned roots are not covered.',
];

/** Marker checks use forward slashes on every platform. */
export const posix = (p: string): string => p.split(sep).join('/');
const isInside = (child: string, parent: string): boolean => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
export const nowIso = (): string => isoLocal(new Date());

function isoLocal(date: Date): string {
  const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0, 19);
  return `${local}${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`;
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export function family(path: string): RuleFamily {
  const name = basename(path), s = posix(path);
  if (name.startsWith('AGENTS')) return 'Codex / shared';
  if (name.startsWith('CLAUDE') || s.includes('/.claude/rules/')) return 'Claude';
  if (name === '.cursorrules' || s.includes('/.cursor/rules/')) return 'Cursor';
  if (name === 'GEMINI.md') return 'Gemini';
  if (s.includes('windsurf')) return 'Windsurf';
  return 'Copilot';
}

export function scopeOf(path: string): Scope {
  return AGENT_DIRS.some(dir => isInside(path, join(HOME, dir))) ? 'User-wide' : 'Folder';
}

export function folderFor(path: string): string {
  const s = posix(path);
  for (const marker of ['/.claude/', '/.agents/', '/.cursor/', '/.codex/', '/.vibe/', '/.windsurf/', '/.github/']) {
    if (s.includes(marker) && scopeOf(path) !== 'User-wide') return path.slice(0, s.indexOf(marker));
  }
  return dirname(path);
}

export function agentFor(path: string): Agent {
  const s = posix(path);
  if (s.includes('/.claude/') || s.endsWith('/.mcp.json')) return 'Claude';
  if (s.includes('/.codex/') || s.includes('/.agents/')) return 'Codex';
  if (s.includes('/.cursor/')) return 'Cursor';
  if (s.includes('/.gemini/')) return 'Gemini';
  if (s.includes('/.vibe/')) return 'Vibe';
  return 'Other';
}

/** What Mistral Vibe reads: its own skills folders, `skill_paths` from its config, and trusted projects. */
export interface VibeSetup {
  installed: boolean;
  skillPaths: string[];
  untrusted: string[];
}

export function vibeSetup(errors: string[]): VibeSetup {
  if (!existsSync(VIBE_DIR)) return { installed: false, skillPaths: [], untrusted: [] };
  const config = existsSync(join(VIBE_DIR, 'config.toml')) ? readToml(join(VIBE_DIR, 'config.toml'), errors) : {};
  const trust = existsSync(join(VIBE_DIR, 'trusted_folders.toml')) ? readToml(join(VIBE_DIR, 'trusted_folders.toml'), errors) : {};
  const paths = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => resolve(expandPath(v.trim()))) : []);
  return { installed: true, skillPaths: paths(config.skill_paths), untrusted: paths(trust.untrusted) };
}

/**
 * Every agent that loads a skill from this path. One folder can serve several agents: Codex and Vibe both
 * read a project's .agents/skills, and Vibe reads any folder listed in its skill_paths.
 */
export function skillAgents(path: string, vibe: VibeSetup): Agent[] {
  const s = posix(path);
  const agents = new Set<Agent>([agentFor(path)]);
  if (vibe.installed) {
    // Vibe skips project skills in folders the user marked untrusted.
    const projectShared = s.includes('/.agents/skills/') && scopeOf(path) !== 'User-wide' && !vibe.untrusted.some(u => isInside(path, u));
    if (projectShared || vibe.skillPaths.some(p => isInside(path, p))) agents.add('Vibe');
  }
  if (agents.size > 1) agents.delete('Other');
  return [...agents].sort();
}

export function record(path: string, kind?: RuleFamily): FileRecord {
  const raw = readFileSync(path);
  const text = raw.toString('utf8');
  return { path, key: path, folder: folderFor(path), family: kind ?? family(path), scope: scopeOf(path), bytes: raw.length, lines: text === '' ? 0 : text.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0), modified: isoLocal(statSync(path).mtime), sha256: sha256(raw), text, imports: [] };
}

const isRule = (path: string): boolean => RULE_NAMES.has(basename(path)) || basename(path).endsWith('.instructions.md') || RULE_DIRS.some(d => posix(path).includes(d));

type ConfigKind = 'skills-lock' | 'mcp-json' | 'claude-settings' | 'cursor-mcp' | 'codex-config' | 'vibe-config' | 'vibe-hooks' | 'command' | 'subagent' | 'output-style';

function configKind(path: string): ConfigKind | null {
  const name = basename(path), parent = basename(dirname(path)), grand = basename(dirname(dirname(path)));
  if (name === SKILLS_LOCK) return 'skills-lock';
  if (name === '.mcp.json') return 'mcp-json';
  if (parent === '.claude' && (name === 'settings.json' || name === 'settings.local.json')) return 'claude-settings';
  if (parent === '.cursor' && name === 'mcp.json') return 'cursor-mcp';
  if (parent === '.codex' && (name === 'config.toml' || name === 'hooks.json')) return 'codex-config';
  if (parent === '.vibe' && name === 'config.toml') return 'vibe-config';
  if (parent === '.vibe' && name === 'hooks.toml') return 'vibe-hooks';
  if (name.endsWith('.md') && posix(path).includes('/.claude/commands/')) return 'command';
  if (name.endsWith('.md') && parent === 'agents' && grand === '.claude') return 'subagent';
  if (name.endsWith('.md') && parent === 'output-styles' && grand === '.claude') return 'output-style';
  return null;
}

interface Discovered {
  rules: Set<string>;
  skills: Set<string>;
  config: Map<ConfigKind, Set<string>>;
  unreadable: string[];
}

/** Skill folders are often symlinks (for example `npx skills` links .claude/skills to .agents/skills). */
function linkedSkillFiles(link: string, insideSkillsDir: boolean): string[] {
  try {
    const candidates = insideSkillsDir ? [join(link, SKILL_NAME)] : readdirSync(link).map(child => join(link, child, SKILL_NAME));
    return candidates.filter(p => existsSync(p) && statSync(p).isFile());
  } catch { return []; }
}

/** Walks roots like `rg --files --hidden --no-ignore`, pruning excluded folder names and not following symlinks. */
export function discover(roots: string[], excluded: string[], errors: string[], ignored: string[] = []): Discovered {
  const found: Discovered = { rules: new Set(), skills: new Set(), config: new Map(), unreadable: [] };
  const skip = new Set(excluded);
  const skipPaths = new Set(ignored);
  const walk = (dir: string, isRoot: boolean): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      errors.push(`${error instanceof Error ? error.message : String(error)}`);
      if (isRoot) found.unreadable.push(dir);
      return;
    }
    const here = basename(dir);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (!skip.has(entry.name) && !skipPaths.has(full)) walk(full, false); continue; }
      if (entry.isSymbolicLink()) {
        let target;
        try { target = statSync(full); } catch { continue; }
        if (target.isDirectory()) {
          if (!skip.has(entry.name) && !skipPaths.has(full) && (entry.name === 'skills' || here === 'skills')) linkedSkillFiles(full, here === 'skills').forEach(p => found.skills.add(p));
          continue;
        }
      }
      if (entry.name === SKILL_NAME) found.skills.add(full);
      else if (isRule(full)) found.rules.add(full);
      else {
        const kind = configKind(full);
        if (kind) { if (!found.config.has(kind)) found.config.set(kind, new Set()); found.config.get(kind)!.add(full); }
      }
    }
  };
  roots.forEach(root => walk(root, true));
  return found;
}

/** Minimal YAML front matter reader for the flat keys skills, commands and subagents use. */
export function frontmatter(text: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(text);
  if (!match?.[1]) return {};
  const meta: Record<string, string> = {};
  const lines = match[1].split('\n');
  let i = 0;
  while (i < lines.length) {
    const found = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i] ?? '');
    i += 1;
    if (!found?.[1]) continue;
    let value = (found[2] ?? '').trim();
    if (['>', '|', '>-', '|-', ''].includes(value)) {
      const block: string[] = [];
      while (i < lines.length && (!(lines[i] ?? '').trim() || /^[ \t]/.test(lines[i] ?? ''))) { block.push((lines[i] ?? '').trim()); i += 1; }
      value = block.filter(Boolean).join(value.startsWith('>') || !value ? ' ' : '\n');
    }
    meta[found[1]] = value.trim().replace(/^["']+|["']+$/g, '');
  }
  return meta;
}

export const stripFrontmatter = (text: string): string => text.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
const firstLine = (text: string): string => stripFrontmatter(text).split('\n').map(l => l.replace(/^[#\s]+|[#\s]+$/g, '').trim()).find(Boolean) ?? '';

function skillSource(path: string, plugin: PluginRoot | null): SkillSource {
  const s = posix(path);
  if (plugin) return 'plugin';
  if (s.includes('/.claude/skills/synced/')) return 'synced';
  if (SYSTEM_SKILL_MARKERS.some(m => s.includes(m))) return 'system';
  return scopeOf(path) === 'User-wide' ? 'user' : 'project';
}

function supportFileCount(dir: string, excluded: Set<string>): number {
  let count = 0;
  const walk = (d: string): void => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!excluded.has(e.name)) walk(join(d, e.name)); }
      else count += 1;
    }
  };
  walk(dir);
  return count - 1;
}

interface PluginRoot {
  id: string;
  agent: Agent;
  root: string;
  version: string | null;
  installedAt: string | null;
  /** Where the plugin is published: its homepage or repository, else its marketplace's repository. */
  homepage: string | null;
}

/** Only web links are kept, so a manifest cannot smuggle in a file: or javascript: URL. */
const webUrl = (value: unknown): string | null => {
  const text = asString(value)?.trim() ?? '';
  return /^https?:\/\/[^\s]+$/i.test(text) ? text : null;
};

function pluginHomepage(root: string, id: string, marketplaces: Record<string, unknown>, errors: string[]): string | null {
  for (const manifest of [join(root, '.claude-plugin', 'plugin.json'), join(root, '.codex-plugin', 'plugin.json')]) {
    if (!existsSync(manifest)) continue;
    const data = readJson(manifest, errors);
    const repository = asRecord(data.repository);
    const link = webUrl(data.homepage) ?? webUrl(data.repository) ?? webUrl(repository.url);
    if (link) return link;
  }
  const source = asRecord(asRecord(marketplaces[id.split('@')[1] ?? '']).source);
  const repo = asString(source.repo);
  return source.source === 'github' && repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}` : webUrl(source.url);
}

function skillRecord(path: string, excluded: Set<string>, plugin: PluginRoot | null, origins: Map<string, string>, vibe: VibeSetup): FileRecord {
  const item = record(path, 'Skill');
  const meta = frontmatter(item.text);
  const dir = dirname(path);
  if (plugin) item.key = `plugin:${plugin.id}:${relative(plugin.root, path)}`;
  if (lstatSync(dir).isSymbolicLink()) item.linkTarget = realpathSync(path);
  const real = realpathSync(path);
  if (real !== path) item.realPath = real;
  // Vibe loads skill_paths folders in every project, wherever they live.
  if (!plugin && item.scope === 'Folder' && vibe.skillPaths.some(p => isInside(path, p))) { item.scope = 'User-wide'; item.folder = HOME; }
  item.skill = {
    name: meta.name || basename(dir),
    description: meta.description ?? '',
    agent: plugin ? plugin.agent : agentFor(path),
    agents: plugin ? [plugin.agent] : skillAgents(path, vibe),
    source: skillSource(path, plugin),
    origin: plugin ? plugin.id : origins.get(`${item.folder}\u0000${basename(dir)}`) ?? null,
    plugin: plugin ? { id: plugin.id, version: plugin.version, installedAt: plugin.installedAt } : null,
    supportFiles: supportFileCount(dir, excluded),
    manualOnly: meta['disable-model-invocation'] === 'true',
    hiddenFromMenu: meta['user-invocable'] === 'false',
  };
  return item;
}

function readJson(path: string, errors: string[]): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) { errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); return {}; }
}

function readToml(path: string, errors: string[]): Record<string, unknown> {
  try { return parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>; }
  catch (error) { errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); return {}; }
}

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function skillOrigins(lockFiles: Iterable<string>, errors: string[]): Map<string, string> {
  const origins = new Map<string, string>();
  for (const lock of lockFiles) {
    const skills = asRecord(readJson(lock, errors).skills);
    for (const [name, entry] of Object.entries(skills)) {
      const source = asString(asRecord(entry).source);
      if (source) origins.set(`${dirname(lock)}\u0000${name}`, source);
    }
  }
  return origins;
}

function latestChild(folder: string): string | null {
  try {
    const dirs = readdirSync(folder, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(folder, e.name));
    return dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
  } catch { return null; }
}

/** Enabled Claude Code and Codex plugins with the folder holding their current version. */
function enabledPlugins(errors: string[]): PluginRoot[] {
  const plugins: PluginRoot[] = [];
  const installed = existsSync(CLAUDE_INSTALLED_PLUGINS) ? asRecord(readJson(CLAUDE_INSTALLED_PLUGINS, errors).plugins) : {};
  const enabled = existsSync(CLAUDE_SETTINGS) ? asRecord(readJson(CLAUDE_SETTINGS, errors).enabledPlugins) : {};
  const marketplaces = existsSync(CLAUDE_MARKETPLACES) ? readJson(CLAUDE_MARKETPLACES, errors) : {};
  for (const [id, entries] of Object.entries(installed)) {
    if (!enabled[id] || !Array.isArray(entries)) continue;
    for (const entry of entries.map(asRecord)) {
      const root = asString(entry.installPath);
      if (root) plugins.push({ id, agent: 'Claude', root, version: asString(entry.version), installedAt: asString(entry.installedAt), homepage: pluginHomepage(root, id, marketplaces, errors) });
    }
  }
  const config = existsSync(CODEX_CONFIG) ? readToml(CODEX_CONFIG, errors) : {};
  for (const [id, settings] of Object.entries(asRecord(config.plugins))) {
    if (asRecord(settings).enabled !== true || !id.includes('@')) continue;
    const [name, marketplace] = id.split('@', 2) as [string, string];
    const root = latestChild(join(CODEX_PLUGIN_CACHE, marketplace, name));
    if (root) plugins.push({ id, agent: 'Codex', root, version: basename(root), installedAt: null, homepage: pluginHomepage(root, id, {}, errors) });
  }
  return plugins;
}

/** Hook commands are shown to the user, so anything that looks like a credential is masked. */
export function redact(command: string): string {
  const text = command.split(HOME).join('~').replace(SECRET_ASSIGNMENT, (_m, key: string) => `${key}=•••`).replace(LONG_TOKEN, '•••');
  return text.length <= HOOK_COMMAND_CHARS ? text : `${text.slice(0, HOOK_COMMAND_CHARS)}…`;
}

interface ItemPlacement { folder?: string; plugin?: PluginRoot | null; userWide?: boolean }

function base(source: string, placement: ItemPlacement): { folder: string; scope: Scope; plugin: string | null } {
  const wide = placement.userWide ?? scopeOf(source) === 'User-wide';
  return { folder: wide ? HOME : placement.folder ?? folderFor(source), scope: wide ? 'User-wide' : 'Folder', plugin: placement.plugin?.id ?? null };
}

function hookItems(hooks: unknown, agent: Agent, source: string, placement: ItemPlacement = {}): HookExtra[] {
  const items: HookExtra[] = [];
  for (const [event, groups] of Object.entries(asRecord(hooks))) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups.map(asRecord)) {
      const handlers = Array.isArray(group.hooks) ? group.hooks.map(asRecord) : [];
      for (const handler of handlers) {
        const command = asString(handler.command) ?? asString(handler.url) ?? asString(handler.prompt) ?? asString(handler.type) ?? '';
        const matcher = asString(group.matcher) ?? '';
        const key = `hook:${source}:${event}:${matcher}:${sha256(command).slice(0, 10)}`;
        items.push({ kind: 'hook', name: event, agent, path: source, ...base(source, placement), key, sha256: key, event, matcher, handlerType: asString(handler.type) ?? 'command', command: redact(command), timeout: typeof handler.timeout === 'number' ? handler.timeout : null, status: asString(handler.statusMessage) });
      }
    }
  }
  return items;
}

function mcpTarget(server: Record<string, unknown>): string {
  const url = asString(server.url);
  if (url) return url.replace(/[?#].*$/, '').replace(/^(https?:\/\/)[^/@]*@/, '$1');
  const command = basename(asString(server.command) ?? '');
  const args = Array.isArray(server.args) ? server.args.filter((a): a is string => typeof a === 'string') : [];
  const pkg = args.find(a => PACKAGE_ARG.test(a) && !a.startsWith('-') && !new RegExp(LONG_TOKEN.source).test(a)) ?? '';
  return `${command} ${pkg}`.trim();
}

/** Same bytes as Python's json.dumps([a, b]), so fingerprints match the earlier Python inventory. */
const pythonJsonPair = (a: string, b: string): string => `[${asciiJson(a)}, ${asciiJson(b)}]`;
const asciiJson = (s: string): string => JSON.stringify(s).replace(/[\u0080-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Only names, transport and host are kept. Environment variables, headers and arguments can hold secrets. */
function mcpItems(servers: unknown, agent: Agent, source: string, mcpScope: McpScope, placement: ItemPlacement = {}): McpExtra[] {
  return Object.entries(asRecord(servers)).filter(([, s]) => typeof s === 'object' && s !== null).map(([name, raw]) => {
    const server = asRecord(raw);
    const where = base(source, placement);
    const transport = asString(server.type) ?? asString(server.transport) ?? (server.url ? 'http' : 'stdio');
    const target = mcpTarget(server);
    return { kind: 'mcp', name, agent, path: source, ...where, key: `mcp:${agent}:${where.folder}:${name}:${mcpScope}`, sha256: sha256(pythonJsonPair(transport, target)), transport, target, mcpScope, enabled: server.enabled !== false };
  });
}

/** Vibe lists hooks as [[hooks]] tables in hooks.toml, each with a type (pre_tool, post_tool, post_agent). */
function vibeHookItems(hooks: unknown, source: string): HookExtra[] {
  if (!Array.isArray(hooks)) return [];
  return hooks.map(asRecord).filter(h => asString(h.type) && asString(h.command)).map(h => {
    const event = asString(h.type) ?? '', matcher = asString(h.match) ?? '', command = asString(h.command) ?? '';
    const key = `hook:${source}:${event}:${matcher}:${sha256(command).slice(0, 10)}`;
    return { kind: 'hook', name: event, agent: 'Vibe', path: source, ...base(source, {}), key, sha256: key, event, matcher, handlerType: 'command', command: redact(command), timeout: typeof h.timeout === 'number' ? h.timeout : null, status: asString(h.description) ?? asString(h.name) };
  });
}

/** Vibe lists MCP servers as [[mcp_servers]] tables with a name, where Claude and Codex key them by name. */
const byName = (servers: unknown): Record<string, unknown> => (Array.isArray(servers) ? Object.fromEntries(servers.map(asRecord).filter(s => asString(s.name)).map(s => [asString(s.name), s])) : {});

function markdownItem(kind: MarkdownExtra['kind'], path: string, agent: Agent, plugin: PluginRoot | null = null, prefix = ''): MarkdownExtra {
  const text = readFileSync(path, 'utf8');
  const meta = frontmatter(text);
  const stem = basename(path).replace(/\.md$/, '');
  return {
    kind, name: prefix + (meta.name || stem), agent, path, ...base(path, { plugin }),
    description: meta.description || firstLine(text), model: meta.model ?? null, tools: meta.tools ?? null,
    text: [...text].slice(0, COMMAND_PREVIEW_CHARS).join(''), truncated: [...text].length > COMMAND_PREVIEW_CHARS,
    key: `${kind}:${plugin ? `${plugin.id}:${relative(plugin.root, path)}` : path}`, sha256: sha256(text),
  };
}

function pluginMarkdown(plugin: PluginRoot, folder: string, kind: MarkdownExtra['kind']): MarkdownExtra[] {
  const dir = join(plugin.root, folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith('.md') && !n.startsWith('_')).sort().map(n => markdownItem(kind, join(dir, n), plugin.agent, plugin, `${plugin.id.split('@')[0]}:`));
}

function collectExtras(config: Map<ConfigKind, Set<string>>, plugins: PluginRoot[], vibe: VibeSetup, errors: string[]): Extras {
  const extras: Extras = { commands: [], subagents: [], hooks: [], mcp: [], outputStyles: [] };
  const files = (kind: ConfigKind): string[] => [...(config.get(kind) ?? [])].sort();
  const safely = (fn: () => void): void => { try { fn(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } };
  for (const p of files('command')) safely(() => extras.commands.push(markdownItem('command', p, 'Claude')));
  for (const p of files('subagent')) safely(() => extras.subagents.push(markdownItem('subagent', p, 'Claude')));
  for (const p of files('output-style')) safely(() => extras.outputStyles.push(markdownItem('output-style', p, 'Claude')));
  for (const p of files('claude-settings')) extras.hooks.push(...hookItems(readJson(p, errors).hooks, 'Claude', p));
  for (const p of files('mcp-json')) extras.mcp.push(...mcpItems(readJson(p, errors).mcpServers, 'Claude', p, 'project', { folder: dirname(p), userWide: false }));
  for (const p of files('cursor-mcp')) extras.mcp.push(...mcpItems(readJson(p, errors).mcpServers, 'Cursor', p, scopeOf(p) === 'User-wide' ? 'user' : 'project'));
  for (const p of files('codex-config')) {
    const data = p.endsWith('.toml') ? readToml(p, errors) : readJson(p, errors);
    extras.hooks.push(...hookItems(data.hooks, 'Codex', p));
    if (p.endsWith('.toml')) extras.mcp.push(...mcpItems(data.mcp_servers, 'Codex', p, scopeOf(p) === 'User-wide' ? 'user' : 'project'));
  }
  // Vibe loads a project's .vibe folder only when the project is trusted.
  const vibeReads = (p: string): boolean => vibe.installed && (scopeOf(p) === 'User-wide' || !vibe.untrusted.some(u => isInside(p, u)));
  for (const p of files('vibe-config').filter(vibeReads)) extras.mcp.push(...mcpItems(byName(readToml(p, errors).mcp_servers), 'Vibe', p, scopeOf(p) === 'User-wide' ? 'user' : 'project'));
  for (const p of files('vibe-hooks').filter(vibeReads)) extras.hooks.push(...vibeHookItems(readToml(p, errors).hooks, p));
  if (existsSync(CLAUDE_JSON)) {
    const claudeJson = readJson(CLAUDE_JSON, errors);
    extras.mcp.push(...mcpItems(claudeJson.mcpServers, 'Claude', CLAUDE_JSON, 'user', { userWide: true }));
    for (const [project, settings] of Object.entries(asRecord(claudeJson.projects))) {
      extras.mcp.push(...mcpItems(asRecord(settings).mcpServers, 'Claude', CLAUDE_JSON, 'local', { folder: project, userWide: false }));
    }
  }
  for (const plugin of plugins.filter(p => p.agent === 'Claude')) {
    extras.commands.push(...pluginMarkdown(plugin, 'commands', 'command'));
    extras.subagents.push(...pluginMarkdown(plugin, 'agents', 'subagent'));
    const hooksFile = join(plugin.root, 'hooks', 'hooks.json');
    if (existsSync(hooksFile)) { const data = readJson(hooksFile, errors); extras.hooks.push(...hookItems(data.hooks ?? data, 'Claude', hooksFile, { plugin, userWide: true })); }
    const manifestFile = join(plugin.root, '.claude-plugin', 'plugin.json');
    const mcpFile = join(plugin.root, '.mcp.json');
    const servers = { ...asRecord(existsSync(mcpFile) ? readJson(mcpFile, errors).mcpServers : {}), ...asRecord(existsSync(manifestFile) ? readJson(manifestFile, errors).mcpServers : {}) };
    extras.mcp.push(...mcpItems(servers, 'Claude', mcpFile, 'plugin', { plugin, userWide: true }));
  }
  return extras;
}

type Tracked = FileRecord | Extra;
const allExtras = (extras: Partial<Extras> | undefined): Extra[] => Object.values(extras ?? {}).flat() as Extra[];
const trackedKind = (x: Tracked): string => ('family' in x ? (x.family === 'Skill' ? 'skill' : 'rule') : x.kind);
const trackedName = (x: Tracked): string => ('family' in x ? (x.skill?.name ?? basename(x.path)) : x.name);
const trackedAgent = (x: Tracked): string => ('family' in x ? (x.skill?.agent ?? x.family) : x.agent);
const trackedAgents = (x: Tracked): string[] => ('family' in x && x.skill?.agents ? x.skill.agents : [trackedAgent(x)]);
/** A skill reached through links is one file, so every path to it shares this key. */
const realKey = (x: Tracked): string => ('family' in x && x.family === 'Skill' ? x.realPath ?? x.path : x.key);

/** Carries first-seen dates across scans and returns what changed since the last one. */
function trackChanges(previous: Partial<Inventory>, current: Tracked[], now: string): Omit<HistoryEntry, 'at'> {
  const old = new Map<string, Tracked>([...(previous.files ?? []), ...allExtras(previous.extras)].map(x => [x.key ?? x.path, x]));
  for (const item of current) {
    const before = old.get(item.key);
    item.firstSeen = before?.firstSeen ?? now;
    item.changedAt = before?.changedAt ?? null;
    if (before && before.sha256 !== item.sha256) item.changedAt = now;
  }
  if (!previous.extrasTracked) return { added: [], removed: [], changed: [] };
  // One line per real file: the original path first, then the links to it.
  const summarize = (items: Tracked[]): ChangeSummary[] => {
    const groups = new Map<string, Tracked[]>();
    for (const x of items) groups.set(realKey(x), [...(groups.get(realKey(x)) ?? []), x]);
    return [...groups].map(([real, group]) => {
      const sorted = [...group].sort((a, b) => Number(b.path === real) - Number(a.path === real) || a.path.localeCompare(b.path));
      const first = sorted[0]!;
      return { key: first.key, kind: trackedKind(first), name: trackedName(first), agent: trackedAgent(first), path: first.path, agents: [...new Set(sorted.flatMap(trackedAgents))].sort(), paths: sorted.map(x => x.path) };
    });
  };
  const now_ = new Map(current.map(x => [x.key, x]));
  return {
    added: summarize([...now_].filter(([k]) => !old.has(k)).map(([, x]) => x)),
    removed: summarize([...old].filter(([k]) => !now_.has(k)).map(([, x]) => x)),
    changed: summarize([...now_].filter(([k, x]) => old.has(k) && old.get(k)!.sha256 !== x.sha256).map(([, x]) => x)),
  };
}

function resolveImports(files: FileRecord[], errors: string[]): Map<string, FileRecord> {
  const byPath = new Map(files.map(f => [f.path, f]));
  for (let round = 0; round < IMPORT_ROUNDS; round += 1) {
    const additions: FileRecord[] = [];
    for (const item of byPath.values()) {
      for (const match of item.text.matchAll(/^@(\S+)\s*$/gm)) {
        const ref = match[1] ?? '';
        let target = ref.startsWith('~/') ? join(HOME, ref.slice(2)) : ref;
        if (!isAbsolute(target)) target = join(dirname(item.path), target);
        target = existsSync(target) ? realpathSync(target) : resolve(target);
        const exists = existsSync(target) && statSync(target).isFile();
        if (!item.imports.some(i => i.path === target && i.exists === exists)) item.imports.push({ path: target, exists });
        if (exists && target.endsWith('.md') && !byPath.has(target) && !additions.some(a => a.path === target)) {
          try { additions.push(record(target, 'Referenced document')); } catch (error) { errors.push(String(error)); }
        }
      }
    }
    additions.forEach(a => byPath.set(a.path, a));
    if (!additions.length) break;
  }
  return byPath;
}

function memoryIndexes(): MemoryIndex[] {
  const projects = join(HOME, '.claude', 'projects');
  if (!existsSync(projects)) return [];
  return readdirSync(projects).sort().map(key => join(projects, key, 'memory', 'MEMORY.md')).filter(p => existsSync(p)).map(p => ({ path: p, projectKey: basename(dirname(dirname(p))), topicFiles: readdirSync(dirname(p)).filter(n => n.endsWith('.md')).length }));
}

export interface ScanResult {
  inventory: Inventory;
  changes: Omit<HistoryEntry, 'at'>;
}

/** Read-only inventory of rule files, skills, commands, subagents, hooks and MCP servers. No network requests. */
export function scan(config: ResolvedConfig, previous: Partial<Inventory> = {}): ScanResult {
  const errors: string[] = [];
  const now = nowIso();
  const roots = [...config.codeRoots, ...config.agentRoots].filter(r => !config.ignored.includes(r));
  const excluded = new Set(config.excluded);
  const vibe = vibeSetup(errors);
  const vibeRoots = vibe.skillPaths.filter(p => existsSync(p) && !roots.some(r => isInside(p, r)) && !config.ignored.includes(p));
  const found = discover([...roots, ...vibeRoots], config.excluded, errors, config.ignored);
  for (const name of HOME_RULE_FILES) if (existsSync(join(HOME, name))) found.rules.add(join(HOME, name));
  if (MANAGED_CLAUDE_MD && existsSync(MANAGED_CLAUDE_MD)) found.rules.add(MANAGED_CLAUDE_MD);
  const files: FileRecord[] = [];
  for (const p of [...found.rules].sort()) { try { files.push(record(p)); } catch (error) { errors.push(String(error)); } }
  for (const f of files) {
    // Vibe reads AGENTS.md from the working folder up to the trust root, only in trusted folders.
    if (basename(f.path) === 'AGENTS.md' && f.scope === 'Folder' && vibe.installed && !vibe.untrusted.some(u => isInside(f.path, u))) f.readers = ['Vibe'];
  }
  const byPath = resolveImports(files, errors);
  const origins = skillOrigins(found.config.get('skills-lock') ?? [], errors);
  const skills: FileRecord[] = [];
  for (const p of [...found.skills].sort()) { try { skills.push(skillRecord(p, excluded, null, origins, vibe)); } catch (error) { errors.push(String(error)); } }
  const plugins = enabledPlugins(errors);
  for (const plugin of plugins) {
    const dir = join(plugin.root, 'skills');
    if (!existsSync(dir)) continue;
    for (const child of readdirSync(dir).sort()) {
      const p = join(dir, child, SKILL_NAME);
      if (existsSync(p)) { try { skills.push(skillRecord(p, excluded, plugin, origins, vibe)); } catch (error) { errors.push(String(error)); } }
    }
  }
  const items: FileRecord[] = [...byPath.values(), ...skills];
  const extras = collectExtras(found.config, plugins, vibe, errors);
  // Keep the last known entries for unreadable roots so a blocked scan does not look like deletions.
  const known = new Set([...items, ...allExtras(extras)].map(x => x.key));
  for (const root of found.unreadable) {
    const kept = (previous.files ?? []).filter(f => isInside(f.path, root) && !known.has(f.key));
    items.push(...kept);
    for (const [group, entries] of Object.entries(previous.extras ?? {}) as [keyof Extras, Extra[]][]) {
      (extras[group] as Extra[]).push(...entries.filter(x => isInside(x.path, root) && !known.has(x.key)));
    }
    errors.push(`${root} could not be read; kept ${kept.length} files from the previous scan.`);
  }
  const changes = trackChanges(previous, [...items, ...allExtras(extras)], now);
  let history = previous.history ?? [];
  if (changes.added.length || changes.removed.length || changes.changed.length) history = [...history, { at: now, ...changes }].slice(-HISTORY_LIMIT);
  const installed: InstalledPlugin[] = plugins.map(p => ({ id: p.id, agent: p.agent, version: p.version, path: p.root, installedAt: p.installedAt, homepage: p.homepage }));
  const inventory: Inventory = {
    scannedAt: now, baselineAt: previous.extrasTracked && previous.baselineAt ? previous.baselineAt : now, extrasTracked: true,
    roots, excluded: config.excluded, ignored: config.ignored, errors, files: items, extras, primaryFileCount: files.length, skillCount: skills.length,
    plugins: installed, history, memories: memoryIndexes(), limits: LIMITS,
  };
  return { inventory, changes };
}
