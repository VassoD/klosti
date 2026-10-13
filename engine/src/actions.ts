import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { askClaude } from './ai.ts';
import { analyze, short } from './analyze.ts';
import { AGENT_DIRS, CONFIG_PATH, DEFAULT_CODE_DIRS, expandPath, HOME, KNOWN_AGENTS, saveIgnored, saveUserSettings, type ResolvedConfig } from './config.ts';
import { nowIso, posix, scan } from './scan.ts';
import type { Store } from './store.ts';
import type { Analysis, Finding, Inventory, Judgements, Quote, RuleConflict, Thing } from './types.ts';

const REMOVABLE_KINDS = new Set(['skill', 'command', 'subagent']);
const EDITABLE_KINDS = new Set(['rule', 'skill']);
const PROTECTED_MARKERS = ['/plugins/', '/skills/synced/', '/skills/.system/', '/skills-cursor/', '/builtin/skills/'];
const FUZZY_MATCH_RATIO = 0.82;
const FIX_FILE_CHARS = 40000;
const MAX_PROPOSALS = 20;
const PLUGIN_COMMAND_TIMEOUT_MS = 60000;
const FOLDER_PICKER_TIMEOUT_MS = 10 * 60 * 1000;
const USER_CANCELLED = -128;

/** A request the app refuses, with a message that is safe to show. */
export class ActionRefused extends Error {
  override name = 'ActionRefused';
}

const isInside = (child: string, parent: string): boolean => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const expandHome = (p: string): string => (p.startsWith('~/') ? join(HOME, p.slice(2)) : p);

// ---- rule lines ---------------------------------------------------------------

/** Compares lines while ignoring bullets, quotes, emphasis, spacing and case. */
export const normalize = (text: string): string => text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[`*_"“”']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

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

/** A copied file, or for links, where a removed link pointed (link) or that a link was added (created). */
interface BackupEntry { path: string; at: string; link?: string; created?: boolean }

function manifest(store: Store): Record<string, BackupEntry> {
  const file = join(store.backupsDir, 'manifest.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, BackupEntry> : {};
}

function record(store: Store, entry: Omit<BackupEntry, 'at'>, copyFrom?: string): string {
  mkdirSync(store.backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const id = `${stamp}-${randomBytes(3).toString('hex')}`;
  if (copyFrom) copyFileSync(copyFrom, join(store.backupsDir, `${id}.bak`));
  writeFileSync(join(store.backupsDir, 'manifest.json'), JSON.stringify({ ...manifest(store), [id]: { ...entry, at: nowIso() } }, null, 2));
  return id;
}

export const backUp = (store: Store, path: string): string => record(store, { path }, path);

/** Links have nothing to copy, so the backup keeps what undo needs to put them back or take them away. */
export const backUpLink = (store: Store, path: string, change: { link: string } | { created: true }): string => record(store, { path, ...change });

export function restore(store: Store, id: string): string {
  const entry = manifest(store)[id];
  if (!entry) throw new ActionRefused('That backup is gone.');
  if (entry.created) {
    // Only ever a link Klosti made; a real folder that took its place is left alone.
    if (isSymlink(entry.path)) unlinkSync(entry.path);
    return entry.path;
  }
  if (entry.link) {
    if (existsSync(entry.path) || isSymlink(entry.path)) throw new ActionRefused(`Something else is at ${short(entry.path)} now. Move it away first.`);
    mkdirSync(dirname(entry.path), { recursive: true });
    symlinkSync(entry.link, entry.path, 'dir');
    return entry.path;
  }
  const file = join(store.backupsDir, `${id}.bak`);
  if (!existsSync(file)) throw new ActionRefused('That backup is gone.');
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

// ---- native folder picker ------------------------------------------------------------

/** Opens the system's folder chooser. Resolves to null when the user cancels. */
export function pickFolder(prompt: string): Promise<string | null> {
  const os = platform();
  const [command, args] = os === 'darwin'
    ? ['osascript', ['-e', 'on run argv', '-e', 'tell application "System Events" to activate', '-e', 'return POSIX path of (choose folder with prompt (item 1 of argv) default location (path to home folder))', '-e', 'end run', prompt]]
    : os === 'win32'
      ? ['powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = $args[0]; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`, prompt]]
      : ['zenity', ['--file-selection', '--directory', `--title=${prompt}`]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args as string[], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), FOLDER_PICKER_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('error', () => { clearTimeout(timer); reject(new ActionRefused('This computer has no folder picker Klosti can open. Add the folder in the config file instead.')); });
    child.on('close', code => {
      clearTimeout(timer);
      const path = out.trim().replace(/[\\/]+$/, '');
      if (code === 0 && path) return resolve(path);
      if (code !== 0 && !err.includes(String(USER_CANCELLED)) && os === 'darwin' && err.trim()) return reject(new ActionRefused('The folder picker could not open.'));
      resolve(null);
    });
  });
}

/** Opens a web page in the default browser. The desktop window would otherwise open it inside the app. */
export function openInBrowser(url: string): void {
  if (!/^https:\/\/[^\s]+$/i.test(url)) throw new ActionRefused('Only https links can be opened.');
  const os = platform();
  const [command, args] = os === 'darwin' ? ['open', [url]] : os === 'win32' ? ['explorer', [url]] : ['xdg-open', [url]];
  spawn(command, args as string[], { stdio: 'ignore', detached: true }).unref();
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
  if (!previous.files) {
    const { inventory } = scan(config, previous);
    store.saveInventory(inventory);
    return analyze(inventory, judgements);
  }
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
  const carry = (group: Record<string, { conflicts: RuleConflict[]; at: string; model: string; carriedOver?: boolean }>, beforeStacks: { agent: string; project: string | null; key: string }[], afterStacks: { agent: string; project: string | null; key: string }[]): void => {
    const oldKeys = new Map(beforeStacks.map(s => [`${s.agent}\u0000${s.project}`, s.key]));
    for (const stack of afterStacks) {
      const old = group[oldKeys.get(`${stack.agent}\u0000${stack.project}`) ?? ''];
      if (group[stack.key] || !old) continue;
      group[stack.key] = { ...old, conflicts: old.conflicts.map(c => (editConflict ? editConflict({ ...c }) : c)), carriedOver: true };
    }
  };
  carry(judgements.rules, before.stacks, after.stacks);
  carry(judgements.instructions, before.instructionStacks, after.instructionStacks);
  store.saveJudgements(judgements);
  return analyze(inventory, judgements);
}

function setResolved(store: Store, analysis: Analysis, title: string, resolved: boolean): void {
  const judgements: Judgements = store.judgements();
  for (const stack of analysis.stacks) for (const c of judgements.rules[stack.key]?.conflicts ?? []) if (c.title === title) c.resolved = resolved;
  for (const stack of analysis.instructionStacks) for (const c of judgements.instructions[stack.key]?.conflicts ?? []) if (c.title === title) c.resolved = resolved;
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

  /** A rule file or SKILL.md named in this issue that is safe to edit. Plugin and synced skills would be overwritten. */
  private rulePath(analysis: Analysis, finding: Finding, quoteFile: string): string {
    const path = expandHome(quoteFile);
    const owner = analysis.things.find(t => finding.items.includes(t.id) && EDITABLE_KINDS.has(t.kind) && t.paths.includes(path));
    if (!owner) throw new ActionRefused('That file is not one of the files in this issue.');
    if (owner.kind === 'skill' && (owner.plugin || PROTECTED_MARKERS.some(m => posix(path).includes(m)))) throw new ActionRefused('This skill comes from a plugin or is synced, so an edit would be undone on the next update. Change the other side instead.');
    if (!isInside(path, HOME) || !existsSync(path)) throw new ActionRefused('Only files inside your home folder can be edited.');
    return path;
  }

  private editablePath(analysis: Analysis, finding: Finding, file: string): string | null {
    try { return this.rulePath(analysis, finding, file); } catch (error) { if (error instanceof ActionRefused) return null; throw error; }
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
    const quoted = [...new Set((finding.quotes ?? []).filter(q => !q.removed).flatMap(q => this.editablePath(analysis, finding, q.file) ?? []))].sort();
    const named = analysis.things.filter(t => finding.items.includes(t.id) && EDITABLE_KINDS.has(t.kind)).flatMap(t => t.paths).flatMap(p => this.editablePath(analysis, finding, short(p)) ?? []);
    const paths = quoted.length ? quoted : [...new Set(named)].sort();
    if (!paths.length) throw new ActionRefused('No file in this issue can be edited from here. Plugin skills are replaced on update.');
    const quotes = (finding.quotes ?? []).filter(q => !q.removed).map(q => `- ${q.file}: ${q.text}`).join('\n');
    const files = paths.map(p => `=== ${short(p)} ===\n${readFileSync(p, 'utf8').slice(0, FIX_FILE_CHARS)}`).join('\n\n');
    const prompt = `Two instructions in these agent instruction files (rule files and skills) contradict each other. Only the files below may be edited. Resolve the contradiction with the smallest possible edit.

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
      const { rules, instructions } = this.store.judgements();
      const exists = [...Object.values(rules), ...Object.values(instructions)].some(v => v.conflicts.some(c => c.title === name && c.resolved));
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

  /** Stops scanning a folder, or scans it again. The list lives in the user's config file. */
  ignoreFolder(folder: string, ignore: boolean): ActionReply {
    const path = expandPath(folder.trim()).replace(/[\\/]+$/, '');
    if (!isInside(path, HOME) || path === HOME) throw new ActionRefused('Pick a folder inside your home folder.');
    if (AGENT_DIRS.some(d => path === join(HOME, d))) throw new ActionRefused('This is an agent settings folder. Ignoring it would hide every global rule and skill.');
    const ignored = this.config.ignored;
    if (ignore) {
      if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new ActionRefused('That folder does not exist.');
      if (ignored.includes(path)) throw new ActionRefused('That folder is already ignored.');
      ignored.push(path);
    } else {
      const at = ignored.indexOf(path);
      if (at < 0) throw new ActionRefused('That folder is not ignored.');
      ignored.splice(at, 1);
    }
    saveIgnored(ignored);
    this.store.logAction({ at: nowIso(), kind: ignore ? 'ignore-folder' : 'unignore-folder', files: [short(path)] });
    rescan(this.store, this.config);
    return { message: ignore ? `Stopped scanning ${short(path)}.` : `Scanning ${short(path)} again.` };
  }

  /** Which code folders to scan and which agents the user works with. Agent settings folders are always scanned. */
  saveSettings(roots: string[], agents: string[], ignored?: string[]): ActionReply {
    const folders = [...new Set(roots.map(r => expandPath(r.trim()).replace(/[\\/]+$/, '')).filter(Boolean))];
    if (!folders.length) throw new ActionRefused('Pick at least one folder to scan.');
    const missing = folders.find(f => !existsSync(f) || !lstatSync(f).isDirectory());
    if (missing) throw new ActionRefused(`${short(missing)} is not a folder.`);
    if (folders.includes(HOME)) throw new ActionRefused('Scanning your whole home folder would be slow. Pick the folders where your code lives.');
    const chosen = KNOWN_AGENTS.filter(a => agents.includes(a));
    if (!chosen.length) throw new ActionRefused('Pick at least one agent.');
    const skipped = ignored === undefined ? this.config.ignored : [...new Set(ignored.map(p => expandPath(p.trim()).replace(/[\\/]+$/, '')).filter(Boolean))];
    const outside = skipped.find(p => !isInside(p, HOME) || p === HOME || AGENT_DIRS.some(d => p === join(HOME, d)));
    if (outside) throw new ActionRefused(`${short(outside)} cannot be ignored.`);
    saveUserSettings({ roots: folders, replaceDefaultRoots: true, agents: chosen.length === KNOWN_AGENTS.length ? [] : chosen, ignore: skipped });
    this.config.ignored.splice(0, this.config.ignored.length, ...skipped);
    this.config.codeRoots.splice(0, this.config.codeRoots.length, ...folders);
    this.config.agents.splice(0, this.config.agents.length, ...(chosen.length === KNOWN_AGENTS.length ? [] : chosen));
    this.store.logAction({ at: nowIso(), kind: 'settings', summary: `Scanning ${folders.map(short).join(', ')}${skipped.length ? `, skipping ${skipped.length} ${skipped.length === 1 ? 'folder' : 'folders'}` : ''}. Agents: ${chosen.join(', ')}.` });
    rescan(this.store, this.config);
    return { message: 'Settings saved. Scanned again.' };
  }

  /** The welcome screen: saves the first choices, marks onboarding done and runs the first scan. */
  onboard(roots: string[], agents: string[], ignored: string[]): ActionReply {
    this.saveSettings(roots, agents, ignored);
    saveUserSettings({ onboarded: true });
    this.config.onboarded = true;
    return { message: 'All set. This is everything your agents can see.' };
  }

  /**
   * Starts over: the data folder (scan, AI review, history, backups) and the settings file go to the Trash,
   * so they can still be put back. Rule and skill files are never touched.
   */
  deleteAllData(): ActionReply {
    for (const path of [this.store.dir, CONFIG_PATH]) if (existsSync(path)) moveToTrash(path);
    mkdirSync(this.store.dir, { recursive: true });
    this.proposals.clear();
    this.config.codeRoots.splice(0, this.config.codeRoots.length, ...DEFAULT_CODE_DIRS.map(d => join(HOME, d)).filter(p => existsSync(p)));
    this.config.ignored.splice(0);
    this.config.agents.splice(0);
    this.config.onboarded = false;
    return { message: 'Deleted. Everything is in the Trash if you change your mind.' };
  }

  /** Deletes a skill folder link that only makes an agent list the skill twice. The folder it points to is not touched. */
  removeLink(findingId: string, path: string): ActionReply {
    const finding = this.finding(this.current(), findingId);
    if (!finding.extraLinks?.includes(path)) throw new ActionRefused('That link is not part of this issue.');
    if (!isSymlink(path) || !isInside(path, HOME)) throw new ActionRefused('Only a link inside your home folder can be removed here. Reload.');
    const backup = backUpLink(this.store, path, { link: readlinkSync(path) });
    unlinkSync(path);
    this.store.logAction({ at: nowIso(), kind: 'remove-link', name: basename(path), files: [short(path)], backups: [backup] });
    rescan(this.store, this.config);
    return { message: `Removed the link ${short(path)}. The skill itself is untouched.`, undo: [backup] };
  }

  /** Links a skill kept in ~/.agents/skills into other agents' skills folders. Never copies or moves the skill. */
  shareSkill(thingId: string, agents: string[]): ActionReply {
    const thing = this.thing(this.current(), thingId);
    const enabled = this.config.agents;
    const targets = (thing.share ?? []).filter(s => agents.includes(s.agent) && (!enabled.length || enabled.includes(s.agent)));
    if (!targets.length) throw new ActionRefused('Every agent you picked already sees this skill. Reload.');
    for (const s of targets) {
      if (!isInside(s.source, join(HOME, '.agents', 'skills')) || !existsSync(s.source) || !statSync(s.source).isDirectory()) throw new ActionRefused('The skill folder moved. Reload.');
      if (!isInside(s.link, HOME)) throw new ActionRefused('Links can only be added inside your home folder.');
      if (existsSync(s.link) || isSymlink(s.link)) throw new ActionRefused(`${short(s.link)} already exists. Remove it or rename the skill first.`);
    }
    const backups = targets.map(s => {
      mkdirSync(dirname(s.link), { recursive: true });
      symlinkSync(s.source, s.link, 'dir');
      return backUpLink(this.store, s.link, { created: true });
    });
    const names = targets.map(s => (s.agent === 'Vibe' ? 'Mistral Vibe' : s.agent)).join(' and ');
    this.store.logAction({ at: nowIso(), kind: 'share-skill', name: thing.name, summary: `Linked for ${names}.`, files: targets.map(s => short(s.link)), backups });
    rescan(this.store, this.config);
    return { message: `${thing.name} is now linked for ${names}. It loads in their next session.`, undo: backups };
  }

  disablePlugin(thingId: string): ActionReply {
    const thing = this.thing(this.current(), thingId);
    disablePlugin(thing);
    this.store.logAction({ at: nowIso(), kind: 'disable-plugin', name: thing.plugin ?? '' });
    rescan(this.store, this.config);
    return { message: `Disabled the ${(thing.plugin ?? '').split('@')[0]} plugin. New Claude Code sessions will not load it.` };
  }
}
