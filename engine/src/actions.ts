import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { askClaude } from './ai.ts';
import { analyze, short } from './analyze.ts';
import { HOME, type ResolvedConfig } from './config.ts';
import { nowIso, posix, scan } from './scan.ts';
import type { Store } from './store.ts';
import type { Analysis, Finding, Inventory, Judgements, Quote, RuleConflict, Thing } from './types.ts';

const REMOVABLE_KINDS = new Set(['skill', 'command', 'subagent']);
const PROTECTED_MARKERS = ['/plugins/', '/skills/synced/', '/skills/.system/', '/skills-cursor/', '/builtin/skills/'];
const FUZZY_MATCH_RATIO = 0.82;
const FIX_FILE_CHARS = 40000;
const MAX_PROPOSALS = 20;
const PLUGIN_COMMAND_TIMEOUT_MS = 60000;

/** A request the app refuses, with a message that is safe to show. */
export class ActionRefused extends Error {
  override name = 'ActionRefused';
}

const isInside = (child: string, parent: string): boolean => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const expandHome = (p: string): string => (p.startsWith('~/') ? join(HOME, p.slice(2)) : p);

// ---- rule lines ---------------------------------------------------------------

const normalize = (text: string): string => text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[`*_"“”']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Similarity of two strings in [0, 1], like Python's difflib ratio on characters (2 * matches / total). */
function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j] ?? 0;
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(up, prev[j - 1] ?? 0);
      diag = up;
    }
  }
  return (2 * (prev[b.length] ?? 0)) / (a.length + b.length);
}

/** The one line holding the quoted text. Refuses when it is missing or ambiguous. */
export function locateLine(path: string, quote: string): { index: number; lines: string[] } {
  const lines = readFileSync(path, 'utf8').split(/(?<=\n)/);
  const wanted = normalize(quote);
  if (!wanted) throw new ActionRefused('The quote is empty.');
  let hits = lines.map((line, i) => [line, i] as const).filter(([line]) => normalize(line).includes(wanted)).map(([, i]) => i);
  if (!hits.length) {
    const best = lines.map((line, i) => ({ score: line.trim() ? ratio(wanted, normalize(line)) : 0, i })).sort((x, y) => y.score - x.score)[0];
    if (best && best.score >= FUZZY_MATCH_RATIO) hits = [best.i];
  }
  if (!hits.length) throw new ActionRefused('That exact line is not in the file any more. Open the file to edit it by hand.');
  if (hits.length > 1) throw new ActionRefused(`The text appears on ${hits.length} lines, so the right one is unclear. Edit the file by hand.`);
  return { index: hits[0]!, lines };
}

// ---- backups --------------------------------------------------------------------

interface BackupEntry { path: string; at: string }

function manifest(store: Store): Record<string, BackupEntry> {
  const file = join(store.backupsDir, 'manifest.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, BackupEntry> : {};
}

export function backUp(store: Store, path: string): string {
  mkdirSync(store.backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const id = `${stamp}-${randomBytes(3).toString('hex')}`;
  copyFileSync(path, join(store.backupsDir, `${id}.bak`));
  writeFileSync(join(store.backupsDir, 'manifest.json'), JSON.stringify({ ...manifest(store), [id]: { path, at: nowIso() } }, null, 2));
  return id;
}

export function restore(store: Store, id: string): string {
  const entry = manifest(store)[id];
  const file = join(store.backupsDir, `${id}.bak`);
  if (!entry || !existsSync(file)) throw new ActionRefused('That backup is gone.');
  copyFileSync(file, entry.path);
  return entry.path;
}

// ---- trash and plugins ------------------------------------------------------------

function trashTarget(thing: Thing, path: string): string {
  if (!REMOVABLE_KINDS.has(thing.kind)) throw new ActionRefused(`${thing.kind} items cannot be removed from the app.`);
  if (!thing.paths.includes(path)) throw new ActionRefused('That file is not part of this item.');
  if (thing.plugin) throw new ActionRefused('This comes from a plugin. Disable the plugin instead.');
  if (PROTECTED_MARKERS.some(m => posix(path).includes(m))) throw new ActionRefused('This is managed by an app or synced from your account, so it would come back.');
  const target = thing.kind === 'skill' ? dirname(path) : path;
  if (!isInside(target, HOME) || target === HOME) throw new ActionRefused('Only items inside your home folder can be removed.');
  if (!existsSync(target) && !isSymlink(target)) throw new ActionRefused('It is already gone. Reload.');
  return target;
}

const isSymlink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

function moveIntoFolder(target: string, trashDir: string): void {
  mkdirSync(trashDir, { recursive: true });
  let destination = join(trashDir, basename(target));
  if (existsSync(destination) || isSymlink(destination)) destination = `${destination} ${randomBytes(3).toString('hex')}`;
  // rename moves a symlink itself, never the folder it points to
  renameSync(target, destination);
}

/** Uses the system trash so the user can restore. Links are moved directly so the OS cannot resolve them. */
export function moveToTrash(target: string): void {
  const os = platform();
  if (os === 'darwin') {
    if (!isSymlink(target)) {
      const script = 'on run argv\ntell application "Finder" to delete (POSIX file (item 1 of argv) as alias)\nend run';
      if (spawnSync('osascript', ['-e', script, target]).status === 0) return;
    }
    moveIntoFolder(target, join(HOME, '.Trash'));
    return;
  }
  if (os === 'win32') {
    const method = lstatSync(target).isDirectory() && !isSymlink(target) ? 'DeleteDirectory' : 'DeleteFile';
    const command = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}($args[0], 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    if (spawnSync('powershell', ['-NoProfile', '-Command', command, target]).status === 0) return;
    throw new ActionRefused('Windows could not move it to the Recycle Bin.');
  }
  if (spawnSync('gio', ['trash', target]).status === 0) return;
  moveIntoFolder(target, join(process.env.XDG_DATA_HOME ?? join(HOME, '.local', 'share'), 'Trash', 'files'));
}

function disablePlugin(thing: Thing): void {
  if (!thing.plugin) throw new ActionRefused('This item is not part of a plugin.');
  if (!thing.agents.includes('Claude')) throw new ActionRefused(`Disable ${thing.plugin} in ~/.codex/config.toml by setting enabled = false.`);
  const result = spawnSync('claude', ['plugin', 'disable', thing.plugin, '--scope', 'user'], { encoding: 'utf8', timeout: PLUGIN_COMMAND_TIMEOUT_MS, env: { ...process.env, PATH: `${process.env.PATH ?? ''}:${join(HOME, '.local', 'bin')}` } });
  if (result.status !== 0) throw new ActionRefused(`Claude Code could not disable ${thing.plugin}: ${(result.stderr || result.stdout || String(result.error ?? '')).trim().slice(0, 200)}`);
}

// ---- rescan without losing the AI review --------------------------------------------

type ConflictEdit = (conflict: RuleConflict) => RuleConflict;

/**
 * A change gives the affected skill sets and rule stacks new cache keys. Carry the earlier review over,
 * apply editConflict to each carried contradiction, and mark it so the next review rechecks those places.
 */
export function rescan(store: Store, config: ResolvedConfig, editConflict?: ConflictEdit): Analysis {
  const judgements = store.judgements();
  const previous = store.inventory();
  const before = analyze(previous as Inventory, judgements);
  const { inventory } = scan(config, previous);
  store.saveInventory(inventory);
  const after = analyze(inventory, judgements);
  const keysAfter = new Map(after.things.flatMap(t => t.keys.map(k => [k, t.id] as const)));
  const idMap = new Map(before.things.flatMap(t => { const next = t.keys.map(k => keysAfter.get(k)).find(Boolean); return next ? [[t.id, next] as const] : []; }));
  const oldContexts = new Map(before.contexts.map(c => [`${c.agent}\u0000${c.project}`, c.key]));
  for (const ctx of after.contexts) {
    const old = judgements.skills[oldContexts.get(`${ctx.agent}\u0000${ctx.project}`) ?? ''];
    if (judgements.skills[ctx.key] || !old) continue;
    const groups = old.groups.map(g => ({ ...g, ids: g.ids.flatMap(i => (idMap.has(i) ? [idMap.get(i)!] : [])) })).filter(g => g.ids.length >= 2);
    judgements.skills[ctx.key] = { ...old, groups, carriedOver: true };
  }
  const oldStacks = new Map(before.stacks.map(s => [`${s.agent}\u0000${s.project}`, s.key]));
  for (const stack of after.stacks) {
    const old = judgements.rules[oldStacks.get(`${stack.agent}\u0000${stack.project}`) ?? ''];
    if (judgements.rules[stack.key] || !old) continue;
    judgements.rules[stack.key] = { ...old, conflicts: old.conflicts.map(c => (editConflict ? editConflict({ ...c }) : c)), carriedOver: true };
  }
  store.saveJudgements(judgements);
  return analyze(inventory, judgements);
}

function setResolved(store: Store, analysis: Analysis, title: string, resolved: boolean): void {
  const judgements: Judgements = store.judgements();
  for (const stack of analysis.stacks) for (const c of judgements.rules[stack.key]?.conflicts ?? []) if (c.title === title) c.resolved = resolved;
  store.saveJudgements(judgements);
}

// ---- the actions ------------------------------------------------------------------

export interface ActionReply { message: string; undo?: string[]; open?: string | null; undoResolve?: string | null; preview?: LinePreview; proposal?: FixProposal }
export interface LinePreview { path: string; lineNumber: number; line: string }
export interface FixProposal { id: string; summary: string; costUsd: number; edits: { path: string; before: string; after: string }[] }

interface StoredProposal { title: string; finding: string; summary: string; edits: { path: string; find: string; replace: string }[] }

const FixSchema = z.object({ summary: z.string(), edits: z.array(z.object({ file: z.string(), find: z.string(), replace: z.string() })) });

/** Ties the engine to one data store and scan configuration, and keeps AI proposals server-side. */
export class Actions {
  private readonly proposals = new Map<string, StoredProposal>();

  constructor(private readonly store: Store, private readonly config: ResolvedConfig) {}

  current(): Analysis { return analyze(this.store.inventory() as Inventory, this.store.judgements()); }

  private finding(analysis: Analysis, id: string): Finding {
    const finding = analysis.findings.find(f => f.id === id);
    if (!finding) throw new ActionRefused('This issue is no longer in the scan. Reload.');
    return finding;
  }

  private thing(analysis: Analysis, id: string): Thing {
    const thing = analysis.things.find(t => t.id === id);
    if (!thing) throw new ActionRefused('This item is no longer in the scan. Reload.');
    return thing;
  }

  private rulePath(analysis: Analysis, finding: Finding, quoteFile: string): string {
    const path = expandHome(quoteFile);
    const allowed = new Set(finding.items.flatMap(id => analysis.things.filter(t => t.id === id && t.kind === 'rule').flatMap(t => t.paths)));
    if (!allowed.has(path)) throw new ActionRefused('That file is not one of the rule files in this issue.');
    if (!isInside(path, HOME) || !existsSync(path)) throw new ActionRefused('Only rule files inside your home folder can be edited.');
    return path;
  }

  deleteRuleLine(findingId: string, quoteIndex: number, options: { dryRun?: boolean; expect?: string }): ActionReply {
    const analysis = this.current();
    const finding = this.finding(analysis, findingId);
    const quote: Quote | undefined = finding.quotes?.[quoteIndex];
    if (!quote) throw new ActionRefused('That quote is not part of this issue.');
    const path = this.rulePath(analysis, finding, quote.file);
    const { index, lines } = locateLine(path, quote.text);
    const preview: LinePreview = { path: short(path), lineNumber: index + 1, line: (lines[index] ?? '').replace(/\r?\n$/, '') };
    if (options.dryRun) return { message: '', preview };
    if (options.expect !== preview.line) throw new ActionRefused('The file changed since you looked. Try again.');
    const backup = backUp(this.store, path);
    writeFileSync(path, lines.filter((_, i) => i !== index).join(''));
    this.store.logAction({ at: nowIso(), kind: 'delete-line', title: finding.title, edits: [{ file: preview.path, before: preview.line, after: '' }], backups: [backup] });
    rescan(this.store, this.config, c => (c.title === finding.title ? { ...c, removed: [...(c.removed ?? []), { text: quote.text, backup }] } : c));
    return { message: `Deleted line ${preview.lineNumber} from ${preview.path}. Delete more lines or mark it resolved.`, undo: [backup], open: finding.id };
  }

  async proposeFix(findingId: string): Promise<ActionReply> {
    const analysis = this.current();
    const finding = this.finding(analysis, findingId);
    if (finding.kind !== 'contradiction') throw new ActionRefused('AI fixes are available for contradictions.');
    const quoted = [...new Set((finding.quotes ?? []).filter(q => !q.removed).map(q => this.rulePath(analysis, finding, q.file)))].sort();
    const paths = quoted.length ? quoted : [...new Set(finding.items.flatMap(id => analysis.things.filter(t => t.id === id && t.kind === 'rule').flatMap(t => t.paths)).filter(p => existsSync(p)))].sort();
    if (!paths.length) throw new ActionRefused('No editable rule file found for this issue.');
    const quotes = (finding.quotes ?? []).filter(q => !q.removed).map(q => `- ${q.file}: ${q.text}`).join('\n');
    const files = paths.map(p => `=== ${short(p)} ===\n${readFileSync(p, 'utf8').slice(0, FIX_FILE_CHARS)}`).join('\n\n');
    const prompt = `Two instructions in these agent rule files contradict each other. Resolve the contradiction with the smallest possible edit.

Contradiction: ${finding.title}
${finding.summary}
Conflicting lines:
${quotes}
Suggested direction: ${finding.todo}

${files}

Rules for your answer:
- Prefer rewording one line so both intentions fit. Delete a line only when it is clearly redundant.
- Keep the author's wording, formatting and bullet style. Do not touch anything unrelated.
- Each edit: file (the path exactly as in the === header), find (text copied exactly from that file, whole lines, appearing only once), replace (the new text, or an empty string to delete).
- summary: one plain sentence saying what you changed. Never use em dashes.`;
    const { value, costUsd } = await askClaude(prompt, FixSchema);
    const byShort = new Map(paths.map(p => [short(p), p]));
    const edits = value.edits.map(edit => {
      const path = byShort.get(edit.file) ?? (paths.includes(edit.file) ? edit.file : null);
      if (!path) throw new ActionRefused('The AI suggested editing a file outside this issue. Try again.');
      if (!edit.find || readFileSync(path, 'utf8').split(edit.find).length !== 2) throw new ActionRefused('The AI suggestion did not match the file exactly. Try again.');
      return { path, find: edit.find, replace: edit.replace };
    });
    if (!edits.length) throw new ActionRefused('The AI did not suggest any change. Edit the file by hand.');
    if (this.proposals.size >= MAX_PROPOSALS) this.proposals.delete(this.proposals.keys().next().value!);
    const id = randomBytes(8).toString('hex');
    this.proposals.set(id, { title: finding.title, finding: finding.id, summary: value.summary, edits });
    return { message: '', proposal: { id, summary: value.summary, costUsd: Math.round(costUsd * 1000) / 1000, edits: edits.map(e => ({ path: short(e.path), before: e.find, after: e.replace })) } };
  }

  applyFix(proposalId: string): ActionReply {
    const proposal = this.proposals.get(proposalId);
    this.proposals.delete(proposalId);
    if (!proposal) throw new ActionRefused('This suggestion expired. Ask for a new one.');
    for (const e of proposal.edits) if (readFileSync(e.path, 'utf8').split(e.find).length !== 2) throw new ActionRefused('The file changed since the suggestion. Ask for a new one.');
    const backups = new Map<string, string>();
    for (const e of proposal.edits) {
      if (!backups.has(e.path)) backups.set(e.path, backUp(this.store, e.path));
      writeFileSync(e.path, readFileSync(e.path, 'utf8').replace(e.find, () => e.replace));
    }
    this.store.logAction({ at: nowIso(), kind: 'ai-fix', title: proposal.title, summary: proposal.summary, edits: proposal.edits.map(e => ({ file: short(e.path), before: e.find, after: e.replace })), backups: [...backups.values()] });
    rescan(this.store, this.config, c => (c.title === proposal.title ? { ...c, resolved: true } : c));
    return { message: `Applied the fix to ${[...backups.keys()].map(short).join(', ')}.`, undo: [...backups.values()], open: proposal.finding };
  }

  resolve(findingId: string | undefined, title: string | undefined, resolved: boolean): ActionReply {
    const analysis = this.current();
    let name: string;
    if (resolved) name = this.finding(analysis, findingId ?? '').title;
    else {
      name = title ?? '';
      const exists = Object.values(this.store.judgements().rules).some(v => v.conflicts.some(c => c.title === name && c.resolved));
      if (!exists) throw new ActionRefused('Nothing to bring back.');
    }
    setResolved(this.store, analysis, name, resolved);
    this.store.logAction({ at: nowIso(), kind: resolved ? 'resolve' : 'unresolve', title: name });
    return { message: resolved ? 'Marked as resolved.' : 'Back on the list.', undoResolve: resolved ? name : null, open: resolved ? null : findingId ?? null };
  }

  undo(backups: string[], open?: string): ActionReply {
    const paths = backups.map(b => restore(this.store, b));
    this.store.logAction({ at: nowIso(), kind: 'restore', files: paths.map(short), backups });
    rescan(this.store, this.config);
    return { message: `Restored ${paths.map(short).join(', ')}.`, open: open ?? null };
  }

  trash(thingId: string, path: string): ActionReply {
    const target = trashTarget(this.thing(this.current(), thingId), path);
    moveToTrash(target);
    this.store.logAction({ at: nowIso(), kind: 'trash', name: basename(target), files: [short(target)] });
    rescan(this.store, this.config);
    return { message: `Moved ${basename(target)} to the Trash. You can restore it from there.` };
  }

  disablePlugin(thingId: string): ActionReply {
    const thing = this.thing(this.current(), thingId);
    disablePlugin(thing);
    this.store.logAction({ at: nowIso(), kind: 'disable-plugin', name: thing.plugin ?? '' });
    rescan(this.store, this.config);
    return { message: `Disabled the ${(thing.plugin ?? '').split('@')[0]} plugin. New Claude Code sessions will not load it.` };
  }
}
