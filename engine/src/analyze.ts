import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { AGENT_DIRS, HOME } from './config.ts';
import { stripFrontmatter } from './scan.ts';
import type { Agent, Analysis, FileRecord, Finding, ImportRef, InstructionStack, Inventory, Judgements, ListingBudget, Location, ProjectRef, Quote, RuleConflict, RuleStack, SkillContext, Thing } from './types.ts';

const AGENTS: Agent[] = ['Claude', 'Codex', 'Cursor', 'Gemini'];
const REVIEWED_AGENTS: Agent[] = ['Claude', 'Codex'];
/** Claude Code namespaces these as plugin:skill or anthropic-skills:skill, so they never clash by name. */
const NAMESPACED_SOURCES = new Set(['plugin', 'synced']);
/** Bundled commands seen in Claude Code 2.1.296. A skill with the same name replaces the bundled one. */
const CLAUDE_BUILTIN_COMMANDS = new Set(['code-review', 'security-review', 'simplify', 'init', 'loop', 'schedule', 'run', 'batch', 'doctor', 'review', 'claude-api', 'update-config', 'keybindings-help', 'fewer-permission-prompts', 'plugin-authoring', 'claude-in-chrome', 'workflow-authoring']);
const MCP_PRECEDENCE: Record<string, number> = { local: 0, project: 1, user: 2, plugin: 3 };
const SIMILARITY_THRESHOLD = 0.3;
const MAX_SIMILAR_PAIRS = 60;
/**
 * Claude Code keeps skill descriptions within 1% of the context window, about 8,000 characters on a 200k model.
 * Codex uses 2% of the window, or 8,000 characters when the window is unknown. Both are estimates; /doctor shows the real figure.
 */
const LISTING_BUDGET_CHARS: Partial<Record<Agent, number>> = { Claude: 8000, Codex: 8000 };
const DESCRIPTION_CAP_CHARS = 1536;
const INJECTING_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const STOPWORDS = new Set('a an and are as at be by can do does for from has have how if in into is it its of on or that the this to use used uses using when with without you your user users wants want asks ask asked any all also about after before each every other own via etc e.g like such should must may will would claude codex agent agents skill skills task tasks work working help helps provide provides make makes need needs new one more most only than then them they these those what which who whenever trigger triggers mentions mention request requests including include includes guidance guide expert reference based not but so just'.split(' '));

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedStrings = (values: Iterable<string>): string[] => [...values].sort(cmp);
export const short = (path: string): string => path.replace(`${HOME}${sep}`, `~${sep}`);
const isInside = (child: string, parent: string): boolean => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const ancestors = (folder: string): string[] => { const out = [folder]; let current = folder; while (dirname(current) !== current) { current = dirname(current); out.push(current); } return out; };

interface Together { agents: Agent[]; where: 'everywhere' | 'projects'; projects: string[] }

function gitRoot(folder: string, projectRoots: string[]): string | null {
  const stops = new Set([HOME, ...projectRoots]);
  for (const candidate of ancestors(folder)) {
    if (stops.has(candidate)) break;
    if (existsSync(join(candidate, '.git'))) return candidate;
  }
  return null;
}

function projectFor(scope: string, folder: string, projectRoots: string[]): Omit<ProjectRef, 'name'> | null {
  if (scope === 'User-wide') return null;
  let root = gitRoot(folder, projectRoots);
  if (!root) {
    const base = projectRoots.find(b => isInside(folder, b) && folder !== b);
    if (base) root = join(base, relative(base, folder).split(sep)[0] ?? '');
  }
  root ??= folder;
  const sub = isInside(folder, root) ? relative(root, folder) : '';
  return { id: root, path: root, subpath: sub === '.' ? '' : sub };
}

function nameProjects(projects: Map<string, ProjectRef>): void {
  const counts = new Map<string, number>();
  for (const p of projects.values()) counts.set(basename(p.path), (counts.get(basename(p.path)) ?? 0) + 1);
  for (const p of projects.values()) {
    const name = basename(p.path);
    const clashes = (counts.get(name) ?? 0) > 1 || AGENTS.includes(name as Agent);
    p.name = clashes ? `${name} · ${basename(dirname(p.path))}` : name;
  }
}

function hasClaudeMdAbove(folder: string, byPath: Map<string, FileRecord>): boolean {
  for (const candidate of ancestors(folder)) {
    if (candidate === HOME) return false;
    if (['CLAUDE.md', 'CLAUDE.local.md', join('.claude', 'CLAUDE.md')].some(n => byPath.has(join(candidate, n)))) return true;
  }
  return false;
}

function claudeImportClosure(files: FileRecord[], byPath: Map<string, FileRecord>): Set<string> {
  const reached = new Set<string>();
  const walk = (path: string): void => {
    if (reached.has(path)) return;
    reached.add(path);
    for (const ref of byPath.get(path)?.imports ?? []) if (ref.exists) walk(ref.path);
  };
  files.filter(f => f.family === 'Claude').forEach(f => walk(f.path));
  return reached;
}

function ruleAgents(f: FileRecord, byPath: Map<string, FileRecord>, reached: Set<string>): Agent[] {
  if (f.family === 'Codex / shared') {
    // Claude reads a project AGENTS.md only when no CLAUDE.md sits there or above; never Codex's global file.
    const readsDirectly = f.scope !== 'User-wide' && !hasClaudeMdAbove(dirname(f.path), byPath);
    return reached.has(f.path) || readsDirectly ? ['Codex', 'Claude'] : ['Codex'];
  }
  if (f.family === 'Referenced document') return reached.has(f.path) ? ['Claude'] : [];
  return [f.family as Agent];
}

const ruleTitle = (text: string, path: string): string => text.split(/\r?\n/).map(l => /^#\s+(.+)/.exec(l)?.[1]?.trim()).find(Boolean) ?? basename(path);

interface Draft extends Omit<Thing, 'id' | 'projects' | 'locations' | 'global'> { project: Omit<ProjectRef, 'name'> | null }

function buildThings(data: Inventory, projectRoots: string[]): { things: Thing[]; projects: ProjectRef[] } {
  const files = data.files.filter(f => f.family !== 'Skill');
  const byPath = new Map(files.map(f => [f.path, f]));
  const reached = claudeImportClosure(files, byPath);
  const drafts: Draft[] = [];
  const add = (raw: { scope: Thing['scope']; folder: string; path: string; key: string; firstSeen?: string; changedAt?: string | null }, plugin: string | null, fields: Omit<Draft, 'scope' | 'folder' | 'paths' | 'keys' | 'firstSeen' | 'changedAt' | 'plugin' | 'project'>): void => {
    drafts.push({ scope: raw.scope, folder: raw.folder, paths: [raw.path], keys: [raw.key], firstSeen: raw.firstSeen ?? null, changedAt: raw.changedAt ?? null, plugin, ...fields, project: projectFor(raw.scope, raw.folder, projectRoots) });
  };
  for (const f of files) {
    if (!f.text.trim() && f.family === 'Referenced document') continue;
    add(f, null, { kind: 'rule', name: basename(f.path), title: ruleTitle(f.text, f.path), agents: ruleAgents(f, byPath, reached), description: '', body: f.text, sha: f.sha256, lines: f.lines, empty: !f.text.trim(), imports: f.imports as ImportRef[], family: f.family, loadsWhen: dirname(f.path) !== f.folder && f.scope !== 'User-wide' ? 'nested' : 'start' });
  }
  for (const f of data.files) {
    if (f.family !== 'Skill' || !f.skill) continue;
    const sk = f.skill;
    add(f, sk.plugin?.id ?? null, { kind: 'skill', name: sk.name, title: sk.name, agents: [sk.agent], description: sk.description, body: stripFrontmatter(f.text), sha: f.sha256, source: sk.source, origin: sk.origin, version: sk.plugin?.version ?? null, supportFiles: sk.supportFiles, manualOnly: sk.manualOnly, hiddenFromMenu: sk.hiddenFromMenu, linkTarget: f.linkTarget ?? null });
  }
  const extras = data.extras;
  for (const x of [...extras.commands, ...extras.subagents, ...extras.outputStyles]) {
    add(x, x.plugin, { kind: x.kind, name: x.name, title: x.name, agents: [x.agent], description: x.description ?? '', body: stripFrontmatter(x.text ?? ''), sha: x.sha256, model: x.model, tools: x.tools });
  }
  for (const x of extras.hooks) {
    add(x, x.plugin, { kind: 'hook', name: x.event, title: x.event + (x.matcher ? ` · ${x.matcher}` : ''), agents: [x.agent], description: x.status ?? '', body: '', sha: x.sha256, event: x.event, matcher: x.matcher, command: x.command, handlerType: x.handlerType, timeout: x.timeout });
  }
  for (const x of extras.mcp) {
    add(x, x.plugin, { kind: 'mcp', name: x.name, title: x.name, agents: [x.agent], description: x.target, body: '', sha: x.sha256, transport: x.transport, target: x.target, mcpScope: x.mcpScope });
  }
  const things = mergeCopies(drafts);
  const projects = new Map<string, ProjectRef>();
  for (const t of things) for (const p of t.projects) if (!projects.has(p.id)) projects.set(p.id, { ...p });
  nameProjects(projects);
  for (const t of things) {
    for (const p of t.projects) p.name = projects.get(p.id)?.name ?? p.name;
    for (const l of t.locations) if (l.project) l.project.name = projects.get(l.project.id)?.name ?? l.project.name;
    t.global = !t.projects.length;
    t.id = `${t.kind}-${sha256Hex(sortedStrings(t.keys).join('|')).slice(0, 12)}`;
  }
  return { things, projects: [...projects.values()].sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase())) };
}

const sameProject = (a: Omit<ProjectRef, 'name'>, b: Omit<ProjectRef, 'name'>): boolean => a.id === b.id && a.path === b.path && a.subpath === b.subpath;

/** Identical rule and skill files become one thing with several locations and the union of agents. */
function mergeCopies(drafts: Draft[]): Thing[] {
  const merged = new Map<string, Thing>();
  const out: Thing[] = [];
  for (const { project, ...draft } of drafts) {
    const key = (draft.kind === 'rule' || draft.kind === 'skill') && !draft.empty ? `${draft.kind}\u0000${draft.sha}` : null;
    const projectRef: ProjectRef | null = project ? { ...project, name: basename(project.path) } : null;
    const location: Location = { path: draft.paths[0] ?? '', agents: draft.agents, project: projectRef ? { ...projectRef } : null, source: draft.source ?? null, linkTarget: draft.linkTarget ?? null };
    const existing = key ? merged.get(key) : undefined;
    if (existing) {
      existing.paths.push(...draft.paths);
      existing.keys.push(...draft.keys);
      existing.agents = sortedStrings(new Set([...existing.agents, ...draft.agents])) as Agent[];
      if (projectRef && !existing.projects.some(p => sameProject(p, projectRef))) existing.projects.push(projectRef);
      if (draft.scope === 'User-wide') existing.scope = 'User-wide';
      const seen = [existing.firstSeen, draft.firstSeen].filter((v): v is string => !!v).sort(cmp);
      existing.firstSeen = seen[0] ?? null;
      existing.locations.push(location);
      continue;
    }
    const thing: Thing = { ...draft, id: '', projects: projectRef ? [projectRef] : [], locations: [location], global: false };
    if (key) merged.set(key, thing);
    out.push(thing);
  }
  return out;
}

/** Two things can only compete when the same agent sees both in at least one place. */
function visibleTogether(a: Thing, b: Thing): Together | null {
  const shared = sortedStrings(a.agents.filter(x => b.agents.includes(x))) as Agent[];
  if (!shared.length) return null;
  if (a.global && b.global) return { agents: shared, where: 'everywhere', projects: [] };
  if (a.global || b.global) return { agents: shared, where: 'projects', projects: (a.global ? b : a).projects.map(p => p.id) };
  const common = sortedStrings(a.projects.map(p => p.id).filter(id => b.projects.some(p => p.id === id)));
  return common.length ? { agents: shared, where: 'projects', projects: [...new Set(common)] } : null;
}

const tokens = (text: string): string[] => (text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter(w => w.length > 2 && !STOPWORDS.has(w));

function vectors(things: Thing[]): Map<string, Map<string, number>> {
  const docs = new Map(things.map(t => [t.id, tokens(`${Array(3).fill(t.name.replace(/[-_:]/g, ' ')).join(' ')} ${t.description.slice(0, 600)}`)]));
  const df = new Map<string, number>();
  for (const words of docs.values()) for (const w of new Set(words)) df.set(w, (df.get(w) ?? 0) + 1);
  const out = new Map<string, Map<string, number>>();
  for (const [id, words] of docs) {
    const tf = new Map<string, number>();
    words.forEach(w => tf.set(w, (tf.get(w) ?? 0) + 1));
    const vec = new Map([...tf].map(([w, c]) => [w, (c / words.length) * Math.log((1 + docs.size) / (1 + (df.get(w) ?? 0)))]));
    const norm = Math.sqrt([...vec.values()].reduce((s, v) => s + v * v, 0)) || 1;
    out.set(id, new Map([...vec].map(([w, v]) => [w, v / norm])));
  }
  return out;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size > b.size ? [b, a] : [a, b];
  let sum = 0;
  for (const [w, v] of small) sum += v * (large.get(w) ?? 0);
  return sum;
}

const plainName = (t: Thing): string => (t.name.split(':').pop() ?? t.name).toLowerCase();

function whereLabel(together: Together, projectsById: Map<string, ProjectRef>): string {
  if (together.where === 'everywhere') return 'Everywhere';
  const names = together.projects.map(p => projectsById.get(p)?.name).filter((n): n is string => !!n);
  return `In ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`;
}

function finding(kind: Finding['kind'], severity: Finding['severity'], title: string, summary: string, happens: string, todo: string, items: string[], together: Together | null, projectsById: Map<string, ProjectRef>, extra: Partial<Finding> = {}): Finding {
  const id = `${kind}-${sha256Hex([kind, ...sortedStrings(items)].join('|')).slice(0, 10)}`;
  return { id, kind, severity, title, summary, happens, todo, items, agents: together?.agents ?? [], where: together ? whereLabel(together, projectsById) : 'Everywhere', projectIds: together?.projects ?? [], ...extra };
}

function label(t: Thing): string {
  if (t.global) {
    if (t.source === 'plugin') return `plugin ${(t.plugin ?? '').split('@')[0]}`;
    if (t.source === 'synced') return 'synced from claude.ai';
    if (t.source === 'system') return 'built into the app';
    return 'global';
  }
  return `project ${t.projects.slice(0, 2).map(p => p.name).join(', ')}`;
}
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Personal beats project; a skill beats a command with the same name. */
function claudeNameWinner(a: Thing, b: Thing): [Thing, Thing] {
  const rank = (t: Thing): number => (t.global ? 0 : 2) + (t.kind === 'skill' ? 0 : 1);
  return rank(a) <= rank(b) ? [a, b] : [b, a];
}

function sameNameFindings(things: Thing[], projectsById: Map<string, ProjectRef>): Finding[] {
  const out: Finding[] = [];
  const callable = things.filter(t => t.kind === 'skill' || t.kind === 'command');
  callable.forEach((a, i) => {
    for (const b of callable.slice(i + 1)) {
      if (plainName(a) !== plainName(b) || a.sha === b.sha || (a.source === 'system' && b.source === 'system')) continue;
      const together = visibleTogether(a, b);
      if (!together) continue;
      if (together.agents.includes('Claude') && (NAMESPACED_SOURCES.has(a.source ?? '') || NAMESPACED_SOURCES.has(b.source ?? '') || a.plugin || b.plugin)) continue;
      let happens: string, todo: string, winner: Thing | null = null;
      if (together.agents.length === 1 && together.agents[0] === 'Claude') {
        const [w, loser] = claudeNameWinner(a, b);
        winner = w;
        happens = `Typing /${plainName(a)} or an automatic match always loads the ${label(w)} version. The ${label(loser)} one is hidden.`;
        todo = `Rename one of them, or delete the ${label(loser)} copy if it is outdated.`;
      } else {
        const agent = together.agents[0];
        happens = agent === 'Codex' ? 'Codex does not merge or rank skills with the same name. Both can appear in the skill list, so either one may be picked.' : `${agent} has no documented rule for two skills with the same name, so either one may be picked.`;
        todo = `Rename one of them so you can tell which one runs.${agent === 'Codex' ? ' You can also disable one with [[skills.config]] in ~/.codex/config.toml.' : ''}`;
      }
      out.push(finding('same-name', 'high', `Two skills named “${plainName(a)}”`, `${capitalize(label(a))} and ${label(b)} define the same name.`, happens, todo, [a.id, b.id], together, projectsById, { winner: winner?.id ?? null }));
    }
  });
  for (const t of callable) {
    if (!t.agents.includes('Claude') || t.plugin || NAMESPACED_SOURCES.has(t.source ?? '') || !CLAUDE_BUILTIN_COMMANDS.has(plainName(t))) continue;
    const together: Together = { agents: ['Claude'], where: t.global ? 'everywhere' : 'projects', projects: t.projects.map(p => p.id) };
    out.push(finding('shadows-builtin', 'medium', `“${plainName(t)}” replaces a built-in command`, `Claude Code ships its own /${plainName(t)}. Your ${label(t)} ${t.kind} has the same name.`, `Here, /${plainName(t)} runs your version instead of the built-in one.`, 'Keep it if that is intended. Otherwise rename yours to get the built-in back.', [t.id], together, projectsById));
  }
  return out;
}

/** Every place an agent sees a distinct set of skills: everywhere (global only), plus each project with its own skills. */
function skillContexts(things: Thing[], projects: ProjectRef[]): SkillContext[] {
  const contexts: SkillContext[] = [];
  for (const agent of REVIEWED_AGENTS) {
    const pool = things.filter(t => (t.kind === 'skill' || t.kind === 'command') && t.agents.includes(agent) && t.source !== 'system' && !t.manualOnly);
    const globalIds = pool.filter(t => t.global).map(t => t.id);
    const candidates: [string | null, string[]][] = [[null, []], ...projects.map((p): [string, string[]] => [p.id, pool.filter(t => t.projects.some(x => x.id === p.id)).map(t => t.id)])];
    for (const [pid, local] of candidates) {
      if (pid && !local.length) continue;
      const ids = [...globalIds, ...local];
      if (ids.length < 2) continue;
      const shas = sortedStrings(pool.filter(t => ids.includes(t.id)).map(t => t.sha));
      contexts.push({ key: sha256Hex(`${agent}|${shas.join('|')}`).slice(0, 16), agent, project: pid, ids, focus: local });
    }
  }
  return contexts;
}

function reviewedFindings(things: Thing[], contexts: SkillContext[], projectsById: Map<string, ProjectRef>, judgements: Judgements): Finding[] {
  const byId = new Map(things.map(t => [t.id, t]));
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const ctx of contexts) {
    for (const group of judgements.skills[ctx.key]?.groups ?? []) {
      const ids = group.ids.filter(i => byId.has(i));
      const pairKey = sortedStrings(ids).join('|');
      if (ids.length < 2 || seen.has(pairKey)) continue;
      seen.add(pairKey);
      const members = ids.map(i => byId.get(i)!);
      const allGlobal = members.every(m => m.global);
      const together: Together = { agents: [ctx.agent], where: allGlobal ? 'everywhere' : 'projects', projects: allGlobal || !ctx.project ? [] : [ctx.project] };
      const verdict = group.verdict ?? 'overlap';
      const severity = verdict === 'conflict' || verdict === 'duplicate' ? 'high' : 'medium';
      out.push(finding('overlap', severity, group.title || members.map(plainName).join(' and '), group.summary ?? '', group.happens ?? '', group.advice ?? '', ids, together, projectsById, { verdict, reviewed: true, likelyPick: group.likelyPick ?? null }));
    }
  }
  return out;
}

const similarHappens = (together: Together): string => (together.agents.length === 1 && together.agents[0] === 'Codex' ? 'Codex lists both and picks by description. There is no documented tie-break.' : 'Claude reads both descriptions and picks the closest match. There is no documented tie-break, so it may pick either one or load both.');

/** Offline fallback for places the AI review has not covered yet: word overlap between names and descriptions. */
function similarFindings(things: Thing[], contexts: SkillContext[], projectsById: Map<string, ProjectRef>, judgements: Judgements): Finding[] {
  const unjudged = contexts.filter(c => !judgements.skills[c.key]);
  if (!unjudged.length) return [];
  const pool = things.filter(t => (t.kind === 'skill' || t.kind === 'command') && t.source !== 'system' && !t.manualOnly);
  const vecs = vectors(pool);
  const byId = new Map(pool.map(t => [t.id, t]));
  const candidates: [number, Thing, Thing, Together][] = [];
  const seen = new Set<string>();
  for (const ctx of unjudged) {
    const ids = ctx.ids.filter(i => byId.has(i));
    const focus = new Set(ctx.focus);
    ids.forEach((aId, i) => {
      for (const bId of ids.slice(i + 1)) {
        const a = byId.get(aId)!, b = byId.get(bId)!;
        if (focus.size && !focus.has(aId) && !focus.has(bId)) continue;
        if (a.sha === b.sha || plainName(a) === plainName(b) || (a.plugin && a.plugin === b.plugin)) continue;
        const pair = sortedStrings([aId, bId]).join('|');
        if (seen.has(pair)) continue;
        seen.add(pair);
        const score = cosine(vecs.get(aId)!, vecs.get(bId)!);
        const together = visibleTogether(a, b);
        if (score >= SIMILARITY_THRESHOLD && together) candidates.push([score, a, b, together]);
      }
    });
  }
  candidates.sort((x, y) => y[0] - x[0]);
  return candidates.slice(0, MAX_SIMILAR_PAIRS).map(([score, a, b, together]) => finding('overlap', 'low', `Possibly overlapping: ${plainName(a)} and ${plainName(b)}`, `Their names and descriptions share ${Math.round(score * 100)}% of their key words. Not reviewed yet.`, similarHappens(together), 'Open both and compare, or run the AI review for a verdict.', [a.id, b.id], together, projectsById, { score: Math.round(score * 100) / 100, verdict: 'candidate', reviewed: false }));
}

function mcpFindings(things: Thing[], projectsById: Map<string, ProjectRef>): Finding[] {
  const out: Finding[] = [];
  const servers = things.filter(t => t.kind === 'mcp' && t.agents.length === 1 && t.agents[0] === 'Claude');
  servers.forEach((a, i) => {
    for (const b of servers.slice(i + 1)) {
      if (a.name !== b.name) continue;
      const together = visibleTogether(a, b);
      if (!together) continue;
      const [winner, loser] = [a, b].sort((x, y) => (MCP_PRECEDENCE[x.mcpScope ?? ''] ?? 9) - (MCP_PRECEDENCE[y.mcpScope ?? ''] ?? 9)) as [Thing, Thing];
      const same = a.sha === b.sha;
      out.push(finding('same-name', same ? 'low' : 'medium', `MCP server “${a.name}” is configured twice`, `Defined at ${winner.mcpScope} scope and at ${loser.mcpScope} scope.`, `Claude Code uses the whole ${winner.mcpScope} entry and ignores the ${loser.mcpScope} one. Settings are not merged.${same ? ' Both point to the same place.' : ' They point to different places.'}`, 'Remove the one you no longer need so there is a single source of truth.', [winner.id, loser.id], together, projectsById, { winner: winner.id }));
    }
  });
  return out;
}

function ruleStack(things: Thing[], projectId: string, agent: Agent): Thing[] {
  return things.filter(t => t.kind === 'rule' && t.agents.includes(agent) && !t.empty && (t.global || t.projects.some(p => p.id === projectId)))
    .sort((a, b) => Number(!a.global) - Number(!b.global) || (a.paths[0]?.length ?? 0) - (b.paths[0]?.length ?? 0));
}

function conflictFindings(conflicts: RuleConflict[], members: Thing[], together: Together, projectsById: Map<string, ProjectRef>, fallbackTitle: string, fallbackHappens: string): Finding[] {
  return conflicts.filter(c => !c.resolved).map(conflict => {
    const removed = new Map((conflict.removed ?? []).map(r => [r.text, r.backup]));
    const quotes: Quote[] = (conflict.quotes ?? []).map(q => ({ ...q, removed: removed.has(q.text), backup: removed.get(q.text) ?? null }));
    const files = new Set([...(conflict.files ?? []), ...quotes.map(q => q.file)]);
    const involved = members.filter(t => (t.kind === 'rule' && files.has(basename(t.paths[0] ?? ''))) || t.paths.some(x => files.has(short(x)) || files.has(x))).map(t => t.id);
    return finding('contradiction', 'high', conflict.title || fallbackTitle, conflict.explanation ?? '', conflict.happens || fallbackHappens, conflict.advice ?? '', involved.length ? involved : members.map(t => t.id), together, projectsById, { quotes, partlyFixed: quotes.some(q => q.removed), reviewed: true });
  });
}

/** Skills that can bring their own instructions into a session. Built-in system skills are left out. */
const instructionSkills = (things: Thing[], agent: Agent): Thing[] => things.filter(t => t.kind === 'skill' && t.agents.includes(agent) && t.source !== 'system' && !!t.body.trim());

/**
 * Every place where skills load next to rule files: everywhere (global only), plus each project with its own
 * rules or skills. A project place only reports contradictions involving something of its own.
 */
function instructionStacks(things: Thing[], projects: ProjectRef[]): InstructionStack[] {
  const out: InstructionStack[] = [];
  for (const agent of REVIEWED_AGENTS) {
    const skills = instructionSkills(things, agent);
    const rules = things.filter(t => t.kind === 'rule' && t.agents.includes(agent) && !t.empty);
    const candidates: [string | null, Thing[]][] = [[null, []], ...projects.map((p): [string, Thing[]] => [p.id, [...ruleStack(things, p.id, agent).filter(t => !t.global), ...skills.filter(t => !t.global && t.projects.some(x => x.id === p.id))]])];
    for (const [pid, local] of candidates) {
      if (pid && !local.length) continue;
      const placeRules = pid ? ruleStack(things, pid, agent) : rules.filter(t => t.global);
      const placeSkills = skills.filter(t => t.global || (!!pid && t.projects.some(x => x.id === pid)));
      if (!placeSkills.length || placeRules.length + placeSkills.length < 2) continue;
      const shas = sortedStrings([...placeRules, ...placeSkills].map(t => t.sha));
      const focusShas = sortedStrings(local.map(t => t.sha));
      out.push({ key: sha256Hex(`${agent}|${shas.join('|')}|focus|${focusShas.join('|')}`).slice(0, 16), agent, project: pid, rules: placeRules.map(t => t.id), skills: placeSkills.map(t => t.id), focus: local.map(t => t.id) });
    }
  }
  return out;
}

function instructionFindings(things: Thing[], stacks: InstructionStack[], projectsById: Map<string, ProjectRef>, judgements: Judgements): Finding[] {
  const byId = new Map(things.map(t => [t.id, t]));
  return stacks.flatMap(stack => {
    const members = [...stack.rules, ...stack.skills].flatMap(id => (byId.has(id) ? [byId.get(id)!] : []));
    const together: Together = { agents: [stack.agent], where: stack.project ? 'projects' : 'everywhere', projects: stack.project ? [stack.project] : [] };
    return conflictFindings(judgements.instructions[stack.key]?.conflicts ?? [], members, together, projectsById, 'A skill contradicts your instructions', `When ${stack.agent} uses the skill, both instructions are in the same session and it may follow either one.`);
  });
}

function ruleFindings(things: Thing[], projects: ProjectRef[], projectsById: Map<string, ProjectRef>, judgements: Judgements): { findings: Finding[]; stacks: RuleStack[] } {
  const out: Finding[] = [];
  const stacks: RuleStack[] = [];
  for (const p of projects) {
    for (const agent of REVIEWED_AGENTS) {
      const stack = ruleStack(things, p.id, agent);
      if (stack.length < 2 || stack.every(t => t.global)) continue;
      const key = sha256Hex(sortedStrings(stack.map(t => t.sha)).join('|') + agent).slice(0, 16);
      stacks.push({ key, project: p.id, agent, rules: stack.map(t => t.id) });
      const together: Together = { agents: [agent], where: 'projects', projects: [p.id] };
      out.push(...conflictFindings(judgements.rules[key]?.conflicts ?? [], stack, together, projectsById, 'Rules that contradict', 'Both rules load into the same session. When instructions contradict, Claude may pick either one.'));
    }
    const inProject = (t: Thing): boolean => t.projects.some(x => x.id === p.id);
    const claudeMd = things.filter(t => t.kind === 'rule' && t.family === 'Claude' && inProject(t) && !t.empty);
    const agentsMd = things.filter(t => t.kind === 'rule' && t.family === 'Codex / shared' && inProject(t) && !t.agents.includes('Claude') && !t.empty);
    if (claudeMd.length && agentsMd.length) {
      const together: Together = { agents: ['Claude', 'Codex'], where: 'projects', projects: [p.id] };
      out.push(finding('drift', 'medium', `Claude and Codex get different instructions in ${p.name}`, 'This project has both a CLAUDE.md and an AGENTS.md, and CLAUDE.md does not import AGENTS.md.', 'Claude reads CLAUDE.md and ignores AGENTS.md here. Codex reads only AGENTS.md. The two agents follow different rules in the same repo.', 'If they should match, keep one file and add a line with @AGENTS.md to CLAUDE.md.', [...claudeMd, ...agentsMd].map(t => t.id), together, projectsById));
    }
  }
  return { findings: out, stacks };
}

function listingFindings(things: Thing[], projects: ProjectRef[], projectsById: Map<string, ProjectRef>): { findings: Finding[]; budgets: ListingBudget[] } {
  const out: Finding[] = [];
  const budgets: ListingBudget[] = [];
  for (const agent of REVIEWED_AGENTS) {
    const limit = LISTING_BUDGET_CHARS[agent] ?? 0;
    for (const pid of [null, ...projects.map(p => p.id)]) {
      const skills = things.filter(t => (t.kind === 'skill' || t.kind === 'command') && t.agents.includes(agent) && !t.manualOnly && (t.global || (pid !== null && t.projects.some(p => p.id === pid))));
      const chars = skills.reduce((s, t) => s + t.name.length + Math.min(t.description.length, DESCRIPTION_CAP_CHARS), 0);
      budgets.push({ agent, project: pid, count: skills.length, chars, limit });
    }
    const mine = budgets.filter(b => b.agent === agent);
    const worst = mine.reduce<ListingBudget | null>((w, b) => (!w || b.chars > w.chars ? b : w), null);
    if (worst && worst.chars > limit) {
      const over = mine.filter(b => b.chars > limit);
      const together: Together = { agents: [agent], where: over.some(b => b.project === null) ? 'everywhere' : 'projects', projects: over.map(b => b.project).filter((p): p is string => !!p) };
      const check = agent === 'Claude' ? 'Run /doctor in Claude Code to see the real figure for your model.' : 'The budget is larger on models with a bigger context window.';
      out.push(finding('budget', 'medium', `${agent} may not see every skill description`, `Up to ${worst.count} skills with about ${worst.chars.toLocaleString('en-US')} characters of descriptions. The estimated budget is ${limit.toLocaleString('en-US')} characters on a 200k-context model.`, `${agent} always keeps every skill name, but drops descriptions once the list is too long${agent === 'Claude' ? ', starting with the skills you use least.' : '.'} A skill without its description is much less likely to be picked automatically. ${check}`, 'Disable plugins you do not use, or mark rarely used skills as manual only with disable-model-invocation: true.', [], together, projectsById, { estimate: true }));
    }
  }
  return { findings: out, budgets };
}

function hookFindings(things: Thing[], projectsById: Map<string, ProjectRef>): Finding[] {
  return things.filter(t => t.kind === 'hook' && INJECTING_EVENTS.has(t.event ?? '') && (t.command ?? '').toLowerCase().includes('inject')).map(t => {
    const together: Together = { agents: t.agents, where: t.global ? 'everywhere' : 'projects', projects: t.projects.map(p => p.id) };
    return finding('hidden', 'medium', 'A hook adds instructions to every session', `${capitalize(label(t))} runs a ${t.event} hook that injects text into the conversation.`, 'These instructions never appear in any CLAUDE.md, so they are easy to forget. They load everywhere the hook applies.', 'Open the hook to see what it adds. Disable the plugin if you do not want it.', [t.id], together, projectsById);
  });
}

/** The same issue found in several projects (for example two clones of one repo) becomes one finding. */
function mergeRepeated(findings: Finding[], projectsById: Map<string, ProjectRef>): Finding[] {
  const merged = new Map<string, Finding>();
  for (const f of findings) {
    const key = [f.kind, f.title.toLowerCase(), ...sortedStrings(f.items)].join('\u0000');
    const m = merged.get(key);
    if (!m) { merged.set(key, f); continue; }
    if (m.where === 'Everywhere' || f.where === 'Everywhere') { m.where = 'Everywhere'; m.projectIds = []; continue; }
    m.projectIds = sortedStrings(new Set([...m.projectIds, ...f.projectIds]));
    m.where = whereLabel({ agents: m.agents, where: 'projects', projects: m.projectIds }, projectsById);
  }
  return [...merged.values()];
}

/** Code roots (not agent settings folders) bound where a project starts. */
export const projectRootsOf = (data: Inventory): string[] => data.roots.filter(r => !AGENT_DIRS.some(d => r === join(HOME, d)));

export function analyze(data: Inventory, judgements: Partial<Judgements> = {}): Analysis {
  const cache: Judgements = { skills: judgements.skills ?? {}, rules: judgements.rules ?? {}, instructions: judgements.instructions ?? {}, digests: judgements.digests ?? {} };
  const { things, projects } = buildThings(data, projectRootsOf(data));
  const projectsById = new Map(projects.map(p => [p.id, p]));
  const contexts = skillContexts(things, projects);
  const rules = ruleFindings(things, projects, projectsById, cache);
  const listing = listingFindings(things, projects, projectsById);
  const istacks = instructionStacks(things, projects);
  const findings = mergeRepeated([
    ...sameNameFindings(things, projectsById),
    ...reviewedFindings(things, contexts, projectsById, cache),
    ...similarFindings(things, contexts, projectsById, cache),
    ...mcpFindings(things, projectsById),
    ...rules.findings,
    ...instructionFindings(things, istacks, projectsById, cache),
    ...listing.findings,
    ...hookFindings(things, projectsById),
  ], projectsById);
  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || cmp(a.kind, b.kind) || cmp(a.title, b.title));
  return { things, projects, findings, contexts, stacks: rules.stacks, instructionStacks: istacks, budgets: listing.budgets };
}
