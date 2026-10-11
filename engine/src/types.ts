export type Agent = 'Claude' | 'Codex' | 'Cursor' | 'Gemini' | 'Other';
export type Scope = 'User-wide' | 'Folder';
export type RuleFamily = 'Claude' | 'Codex / shared' | 'Cursor' | 'Gemini' | 'Windsurf' | 'Copilot' | 'Referenced document' | 'Skill';
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
  source: SkillSource;
  origin: string | null;
  plugin: PluginRef | null;
  supportFiles: number;
  manualOnly: boolean;
  hiddenFromMenu: boolean;
}

/** A rule or skill file, with its full text. */
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
  skill?: SkillMeta;
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
}

export interface MemoryIndex {
  path: string;
  projectKey: string;
  topicFiles: number;
}

export interface Inventory {
  scannedAt: string;
  baselineAt: string;
  extrasTracked: boolean;
  roots: string[];
  excluded: string[];
  errors: string[];
  files: FileRecord[];
  extras: Extras;
  primaryFileCount: number;
  skillCount: number;
  plugins: InstalledPlugin[];
  history: HistoryEntry[];
  memories: MemoryIndex[];
  limits: string[];
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
  loadsWhen?: 'start' | 'nested';
  source?: SkillSource;
  origin?: string | null;
  version?: string | null;
  supportFiles?: number;
  manualOnly?: boolean;
  hiddenFromMenu?: boolean;
  linkTarget?: string | null;
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
  kind: 'same-name' | 'shadows-builtin' | 'overlap' | 'contradiction' | 'drift' | 'budget' | 'hidden';
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
