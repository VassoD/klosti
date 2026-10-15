import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

// The engine reads agent folders from the home folder when it loads, so point HOME at a fixture first.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'klosti-diffs-')));
process.env.HOME = home;
process.env.KLOSTI_SEARCH_PATH = join(home, 'bin');
const { lineDiff } = await import('../src/diff.ts');
const { AGENT_DIRS, EXCLUDED_DIRS } = await import('../src/config.ts');
const { scan, trimHistory } = await import('../src/scan.ts');
const { Snapshots } = await import('../src/snapshots.ts');
type ResolvedConfig = import('../src/config.ts').ResolvedConfig;
type Inventory = import('../src/types.ts').Inventory;
type HistoryEntry = import('../src/types.ts').HistoryEntry;

const write = (path: string, text: string | Buffer): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const code = join(home, 'code');
mkdirSync(code, { recursive: true });
const config = (): ResolvedConfig => ({ codeRoots: [code], agentRoots: AGENT_DIRS.map(d => join(home, d)).filter(p => existsSync(p)), excluded: EXCLUDED_DIRS, ignored: [], agents: [], onboarded: true, dataDir: join(home, '.data') });
const skill = (name: string, body = 'Steps.'): string => `---\nname: ${name}\ndescription: Skill ${name}\n---\n\n${body}\n`;

after(() => rmSync(home, { recursive: true, force: true }));

describe('lineDiff', () => {
  it('should count added and removed lines and keep context around each change', () => {
    const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n');
    const after = ['one', 'two', 'THREE', 'four', 'five', 'six', 'seven', 'eight', 'nine'].join('\n');
    const diff = lineDiff(before, after, 'SKILL.md');
    assert.equal(diff.added, 2, 'THREE and nine are new');
    assert.equal(diff.removed, 1, 'three is gone');
    assert.equal(diff.hunks?.length, 1, 'changes 6 lines apart share one hunk');
    assert.deepEqual(diff.hunks?.[0]?.lines.slice(0, 4), [' one', ' two', '-three', '+THREE'], 'removed comes before added, with context first');
  });

  it('should report an added file as all added lines', () => {
    const diff = lineDiff('', 'a\nb\n', 'notes.md');
    assert.equal(diff.status, 'added');
    assert.deepEqual([diff.added, diff.removed], [2, 0]);
  });

  it('should give counts only when a file is too long to diff line by line', () => {
    const big = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join('\n');
    const diff = lineDiff(big, `${big}\nextra`, 'big.md');
    assert.equal(diff.added, 1, 'the extra line is still counted');
    assert.ok(diff.note, 'a note explains why no lines are shown');
    assert.equal(diff.hunks, undefined);
  });

  it('should cap the lines kept for one file and say so', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 1000 }, (_, i) => (i % 2 ? `new ${i}` : `old ${i}`)).join('\n');
    const diff = lineDiff(before, after, 'churn.md');
    assert.equal(diff.truncated, true);
    const shown = (diff.hunks ?? []).reduce((sum, h) => sum + h.lines.length, 0);
    assert.ok(shown <= 300, `kept ${shown} lines, at most 300`);
  });
});

describe('history size', () => {
  it('should drop hunks and previews from entries older than the latest 30', () => {
    const entry = (i: number): HistoryEntry => ({
      at: `2026-10-${String(i).padStart(2, '0')}`, added: [{ key: `k${i}`, kind: 'skill', name: 'a', agent: 'Claude', path: '/a', preview: ['x'] }], removed: [],
      changed: [{ key: `c${i}`, kind: 'skill', name: 'b', agent: 'Claude', path: '/b', linesAdded: 1, linesRemoved: 0, diffs: [{ file: 'SKILL.md', status: 'changed', added: 1, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: ['+y'] }] }] }],
    });
    const trimmed = trimHistory(Array.from({ length: 35 }, (_, i) => entry(i + 1)));
    assert.equal(trimmed[0]!.changed[0]!.diffs?.[0]?.hunks, undefined, 'the oldest entry lost its lines');
    assert.equal(trimmed[0]!.changed[0]!.linesAdded, 1, 'but kept its counts');
    assert.equal(trimmed[0]!.added[0]!.preview, undefined);
    assert.ok(trimmed[34]!.changed[0]!.diffs?.[0]?.hunks, 'the newest entry keeps its lines');
  });
});

describe('skill changes across scans', () => {
  const dir = join(home, '.claude', 'skills', 'deploy');
  const snapshots = new Snapshots(join(home, '.data', 'snapshots'));
  let inventory: Partial<Inventory> = {};
  const rescan = () => { const result = scan(config(), inventory, { snapshots }); inventory = result.inventory; return result.changes; };

  it('should report a skill whose only change is a reference file, with its lines', () => {
    write(join(dir, 'SKILL.md'), skill('deploy'));
    write(join(dir, 'references', 'steps.md'), 'Build.\nTest.\nShip.\n');
    write(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    rescan();
    write(join(dir, 'references', 'steps.md'), 'Build.\nLint.\nTest.\nShip.\n');
    const changes = rescan();
    const change = changes.changed.find(c => c.name === 'deploy');
    assert.ok(change, 'the skill counts as changed although SKILL.md did not change');
    const ref = change.diffs?.find(d => d.file === 'references/steps.md');
    assert.equal(ref?.added, 1);
    assert.ok(ref?.hunks?.[0]?.lines.includes('+Lint.'), 'the added line is kept');
  });

  it('should note a binary file change without lines', () => {
    write(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x02]));
    const change = rescan().changed.find(c => c.name === 'deploy');
    const logo = change?.diffs?.find(d => d.file === 'logo.png');
    assert.ok(logo?.note, 'binary files get a note instead of lines');
    assert.equal(logo?.hunks, undefined);
  });

  it('should show added and removed supporting files and SKILL.md lines together', () => {
    write(join(dir, 'SKILL.md'), skill('deploy', 'Steps.\nCheck the status page.'));
    write(join(dir, 'references', 'rollback.md'), 'Revert the tag.\n');
    rmSync(join(dir, 'references', 'steps.md'));
    const change = rescan().changed.find(c => c.name === 'deploy');
    const byFile = new Map((change?.diffs ?? []).map(d => [d.file, d]));
    assert.equal(byFile.get('SKILL.md')?.added, 1);
    assert.equal(byFile.get('references/rollback.md')?.status, 'added');
    assert.equal(byFile.get('references/steps.md')?.status, 'removed');
    assert.equal(byFile.get('references/steps.md')?.removed, 4, 'the removed file shows its last copy');
  });

  it('should keep copies only of files the latest scan still has', () => {
    const kept = readdirSync(join(home, '.data', 'snapshots'));
    assert.equal(kept.length, 1, 'only rollback.md is small text left; the old steps.md copies are gone');
  });

  it('should show a preview for an added skill', () => {
    write(join(home, '.claude', 'skills', 'fresh', 'SKILL.md'), skill('fresh', 'First step.'));
    const added = rescan().added.find(c => c.name === 'fresh');
    assert.ok(added?.preview?.includes('First step.'));
  });
});

describe('plugin updates', () => {
  it('should compare a plugin skill with the previous version folder when no copy was kept', () => {
    const cache = join(home, '.claude', 'plugins', 'cache', 'market', 'design');
    const installed = (version: string) => write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'design@market': [{ installPath: join(cache, version), version }] } }));
    write(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'design@market': true } }));
    for (const version of ['1.0.0', '1.1.0']) {
      write(join(cache, version, 'skills', 'swift', 'SKILL.md'), skill('swift'));
      write(join(cache, version, 'skills', 'swift', 'references', 'code.md'), version === '1.0.0' ? 'Use SwiftUI.\n' : 'Use SwiftUI.\nPrefer async.\n');
    }
    installed('1.0.0');
    // An inventory from before folder fingerprints: no file lists and no kept copies.
    const old = scan(config()).inventory;
    for (const f of old.files) if (f.skill) delete f.skill.files;
    installed('1.1.0');
    const change = scan(config(), old).changes.changed.find(c => c.name === 'swift');
    assert.ok(change, 'the plugin skill counts as changed even though its SKILL.md is identical');
    const code = change.diffs?.find(d => d.file === 'references/code.md');
    assert.ok(code?.hunks?.[0]?.lines.includes('+Prefer async.'), 'the line comes from the 1.0.0 folder still on disk');
  });
});
