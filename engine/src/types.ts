import type { FileDiff } from './diff.ts';
export type Agent = 'Claude' | 'Codex' | 'Cursor' | 'Gemini' | 'Vibe' | 'Other';
export type Scope = 'User-wide' | 'Folder';
export type RuleFamily = 'Claude' | 'Codex / shared' | 'Cursor' | 'Gemini' | 'Windsurf' | 'Copilot' | 'Referenced document' | 'Skill' | 'Memory';
export type SkillSource = 'plugin' | 'synced' | 'system' | 'user' | 'project';
export type ThingKind = 'rule' | 'skill' | 'command' | 'subagent' | 'hook' | 'mcp' | 'output-style';
export type Severity = 'high' | 'medium' | 'low';

export interface ImportRef {
  path: string;
  exists: boolean;
}

export interface PluginRef {
  id: string;
  version: string | null;
  installedAt: string | null;
}

export interface SkillMeta {
  name: string;
  description: string;
  agent: Agent;
  /** Every agent that loads the skill from this path. Inventories from before this field only have agent. */
  agents?: Agent[];
  source: SkillSource;
  origin: string | null;
  plugin: PluginRef | null;
  supportFiles: number;
  manualOnly: boolean;
  hiddenFromMenu: boolean;
  /** Every other file in the skill folder, so a change to a reference file counts. Older inventories lack it. */
  files?: SupportFile[];
}

/** A file in a skill folder besides SKILL.md. */
export interface SupportFile {
  /** Relative to the skill folder. */
  path: string;
  sha256: string;
  bytes: number;
  /** Text small enough to keep an earlier copy of, so its changes can be shown line by line. */
  text: boolean;
}

/** What a Claude memory file says about itself in its front matter. */
export interface MemoryMeta {
  /** True for MEMORY.md, the index Claude loads into every session in the project. */
  index: boolean;
  name: string;
  description: string;
  /** user, feedback, project or reference. Null when the file does not say. */
  type: string | null;
}

/** A rule, skill or memory file, with its full text. */
export interface FileRecord {
  path: string;
  key: string;
  folder: string;
  family: RuleFamily;
  scope: Scope;
  bytes: number;
  lines: number;
  modified: string;
  sha256: string;
  text: string;
  imports: ImportRef[];
  linkTarget?: string;
  /** Where the path ends up after every link, when that differs from path. */
  realPath?: string;
  /** Agents that read this rule file besides the ones its name implies, such as Vibe for a project AGENTS.md. */
  readers?: Agent[];
  skill?: SkillMeta;
  memory?: MemoryMeta;
  firstSeen?: string;
  changedAt?: string | null;
}

interface ExtraBase {
  key: string;
  sha256: string;
  kind: 'command' | 'subagent' | 'output-style' | 'hook' | 'mcp';
  name: string;
  agent: Agent;
  path: string;
  folder: string;
  scope: Scope;
  plugin: string | null;
  firstSeen?: string;
  changedAt?: string | null;
}

export interface MarkdownExtra extends ExtraBase {
  kind: 'command' | 'subagent' | 'output-style';
  description: string;
  model: string | null;
  tools: string | null;
  text: string;
  truncated: boolean;
}

export interface HookExtra extends ExtraBase {
  kind: 'hook';
  event: string;
  matcher: string;
  handlerType: string;
  command: string;
  timeout: number | null;
  status: string | null;
}

export type McpScope = 'local' | 'project' | 'user' | 'plugin';

export interface McpExtra extends ExtraBase {
  kind: 'mcp';
  transport: string;
  target: string;
  mcpScope: McpScope;
  enabled: boolean;
}

export type Extra = MarkdownExtra | HookExtra | McpExtra;

export interface Extras {
  commands: MarkdownExtra[];
  subagents: MarkdownExtra[];
  hooks: HookExtra[];
  mcp: McpExtra[];
  outputStyles: MarkdownExtra[];
}

export interface ChangeSummary {
  key: string;
  kind: string;
  name: string;
  agent: string;
  path: string;
  /** One skill reached through links is one change: every agent and path it covers. Older entries lack these. */
  agents?: string[];
  paths?: string[];
  /** Line counts and diffs per file. Older entries, and items without text such as MCP servers, lack them. */
  linesAdded?: number;
  linesRemoved?: number;
  diffs?: FileDiff[];
  /** The first lines of an added or removed file. */
  preview?: string[];
}

export interface HistoryEntry {
  at: string;
  added: ChangeSummary[];
  removed: ChangeSummary[];
  changed: ChangeSummary[];
}

export interface InstalledPlugin {
  id: string;
  agent: Agent;
  version: string | null;
  path: string;
  installedAt: string | null;
  homepage?: string | null;
}

/** A project's Claude memory folder. */
export interface MemoryIndex {
  path: string;
  projectKey: string;
  topicFiles: number;
  /** The folder Claude works in when it loads this memory. Null when that folder no longer exists, so the memory never loads. */
  folder?: string | null;
}

export interface Inventory {
  scannedAt: string;
  baselineAt: string;
  extrasTracked: boolean;
  roots: string[];
  excluded: string[];
  ignored?: string[];
  errors: string[];
  files: FileRecord[];
  extras: Extras;
  primaryFileCount: number;
  skillCount: number;
  plugins: InstalledPlugin[];
  history: HistoryEntry[];
  memories: MemoryIndex[];
  /** Set once memory files are scanned, so the first scan that reads them does not list each one as added. */
  memoriesTracked?: boolean;
  limits: string[];
  /** Agents whose command or app was found. Inventories from before this field only had home folders to go on. */
  installedAgents?: Agent[];
  /** Codex's project_doc_max_bytes and project_doc_fallback_filenames. */
  codexDocs?: { maxBytes: number; fallbacks: string[] };
}

export interface ProjectRef {
  id: string;
  path: string;
  subpath: string;
  name: string;
}

export interface Location {
  path: string;
  agents: Agent[];
  project: ProjectRef | null;
  source: SkillSource | null;
  linkTarget: string | null;
  realPath: string | null;
}

/** A link that would let one more agent load a skill kept in ~/.agents/skills. */
export interface ShareTarget {
  agent: Agent;
  link: string;
  source: string;
}

/** Anything an agent can use: a rule, skill, command, subagent, hook or MCP server. */
export interface Thing {
  id: string;
  kind: ThingKind;
  name: string;
  title: string;
  agents: Agent[];
  description: string;
  body: string;
  sha: string;
  scope: Scope;
  folder: string;
  paths: string[];
  keys: string[];
  firstSeen: string | null;
  changedAt: string | null;
  plugin: string | null;
  projects: ProjectRef[];
  locations: Location[];
  global: boolean;
  family?: RuleFamily;
  lines?: number;
  empty?: boolean;
  imports?: ImportRef[];
  /** start: every session. nested: when working in its folder. recall: when Claude judges the memory relevant. */
  loadsWhen?: 'start' | 'nested' | 'recall';
  memoryType?: string | null;
  source?: SkillSource;
  origin?: string | null;
  version?: string | null;
  supportFiles?: number;
  manualOnly?: boolean;
  hiddenFromMenu?: boolean;
  linkTarget?: string | null;
  realPath?: string | null;
  share?: ShareTarget[];
  model?: string | null;
  tools?: string | null;
  event?: string;
  matcher?: string;
  command?: string;
  handlerType?: string;
  timeout?: number | null;
  transport?: string;
  target?: string;
  mcpScope?: McpScope;
}

export interface Quote {
  file: string;
  text: string;
  removed?: boolean;
  backup?: string | null;
}

export interface Finding {
  id: string;
  kind: 'same-name' | 'shadows-builtin' | 'overlap' | 'contradiction' | 'drift' | 'budget' | 'hidden' | 'listed-twice' | 'too-long';
  severity: Severity;
  title: string;
  summary: string;
  happens: string;
  todo: string;
  items: string[];
  agents: Agent[];
  where: string;
  projectIds: string[];
  winner?: string | null;
  verdict?: string;
  reviewed?: boolean;
  likelyPick?: string | null;
  score?: number;
  quotes?: Quote[];
  partlyFixed?: boolean;
  estimate?: boolean;
  /** Skill folder links that can go because every agent they serve still reaches the skill another way. */
  extraLinks?: string[];
}

export interface SkillGroup {
  verdict: 'duplicate' | 'overlap' | 'conflict';
  ids: string[];
  title: string;
  summary: string;
  happens: string;
  likelyPick?: string;
  advice: string;
}

export interface RuleConflict {
  title: string;
  files: string[];
  quotes: Quote[];
  explanation: string;
  happens: string;
  advice: string;
  resolved?: boolean;
  removed?: { text: string; backup: string | null }[];
}

export interface Judgements {
  skills: Record<string, { groups: SkillGroup[]; at: string; model: string; carriedOver?: boolean }>;
  rules: Record<string, { conflicts: RuleConflict[]; at: string; model: string; carriedOver?: boolean }>;
  /** Contradictions that involve at least one skill, keyed by InstructionStack key. */
  instructions: Record<string, { conflicts: RuleConflict[]; at: string; model: string; carriedOver?: boolean }>;
  /** The behaviour instructions in each skill, quoted verbatim, keyed by the skill's content sha. */
  digests: Record<string, { instructions: string[]; at: string; model: string }>;
}

export interface SkillContext {
  key: string;
  agent: Agent;
  project: string | null;
  ids: string[];
  focus: string[];
}

export interface RuleStack {
  key: string;
  project: string;
  agent: Agent;
  rules: string[];
}

/** A place where skills load next to rule files, checked for contradictions that involve a skill. */
export interface InstructionStack {
  key: string;
  agent: Agent;
  project: string | null;
  rules: string[];
  skills: string[];
  /** Items that only load in this project. Empty for the global place. */
  focus: string[];
}

export interface ListingBudget {
  agent: Agent;
  project: string | null;
  count: number;
  chars: number;
  limit: number;
}

export interface Analysis {
  things: Thing[];
  projects: ProjectRef[];
  findings: Finding[];
  contexts: SkillContext[];
  stacks: RuleStack[];
  instructionStacks: InstructionStack[];
  budgets: ListingBudget[];
}

export interface ActionEntry {
  at: string;
  kind: string;
  title?: string;
  name?: string;
  summary?: string;
  files?: string[];
  edits?: { file: string; before: string; after: string }[];
  backups?: string[];
}
