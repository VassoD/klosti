import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The engine reads agent folders from the home folder when it loads, so point HOME at a fixture first.
// Real paths, because macOS tmp folders sit behind a /var link.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'klosti-home-')));
process.env.HOME = home;
// Agents count as installed by their command, so look for commands only in the fixture.
process.env.KLOSTI_SEARCH_PATH = join(home, 'bin');
const { Actions } = await import('../src/actions.ts');
const { analyze } = await import('../src/analyze.ts');
const { AGENT_DIRS, EXCLUDED_DIRS } = await import('../src/config.ts');
const { scan } = await import('../src/scan.ts');
const { Store } = await import('../src/store.ts');
type ResolvedConfig = import('../src/config.ts').ResolvedConfig;
type Inventory = import('../src/types.ts').Inventory;

const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const skill = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nSteps.\n`;
const link = (target: string, path: string): void => { mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path); };
const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

const code = join(home, 'code');
const shared = join(home, '.agents', 'skills', 'work-ticket');
const config = (): ResolvedConfig => ({ codeRoots: [code], agentRoots: AGENT_DIRS.map(d => join(home, d)).filter(p => existsSync(p)), excluded: EXCLUDED_DIRS, ignored: [], agents: [], onboarded: true, dataDir: join(home, '.data') });

before(() => {
  write(join(shared, 'SKILL.md'), skill('work-ticket', 'Take a ticket from reading to commits'));
  link(shared, join(home, '.claude', 'skills', 'work-ticket'));
  link(shared, join(home, '.codex', 'skills', 'work-ticket'));
  write(join(home, '.vibe', 'config.toml'), 'skill_paths = ["~/.agents/skills"]\n');
  write(join(home, '.vibe', 'trusted_folders.toml'), `trusted = []\nuntrusted = ["${join(code, 'shady')}"]\n`);
  write(join(home, '.vibe', 'skills', 'vibe-only', 'SKILL.md'), skill('vibe-only', 'Only for Mistral Vibe'));
  mkdirSync(join(home, '.gemini'), { recursive: true });
  write(join(home, 'bin', 'gemini'), '');
  for (const name of ['app', 'shady']) {
    mkdirSync(join(code, name, '.git'), { recursive: true });
    write(join(code, name, '.agents', 'skills', `${name}-deploy`, 'SKILL.md'), skill(`${name}-deploy`, `Deploy ${name}`));
  }
});
after(() => rmSync(home, { recursive: true, force: true }));

describe('history', () => {
  it('should record a skill reached through links as one change', () => {
    const { changes } = scan(config(), { extrasTracked: true, files: [], extras: { commands: [], subagents: [], hooks: [], mcp: [], outputStyles: [] } });
    const added = changes.added.filter(c => c.name === 'work-ticket');
    assert.equal(added.length, 1, JSON.stringify(added));
    assert.deepEqual(added[0]?.agents, ['Claude', 'Codex', 'Vibe']);
    assert.equal(added[0]?.paths?.length, 3);
    assert.equal(added[0]?.path, join(shared, 'SKILL.md'), 'the original comes first');
  });
});

describe('Mistral Vibe', () => {
  it('should count skill_paths folders, project .agents/skills and ~/.vibe/skills for Vibe', () => {
    const { files } = scan(config()).inventory;
    const agentsOf = (path: string): string[] | undefined => files.find(f => f.path === path)?.skill?.agents;
    assert.deepEqual(agentsOf(join(shared, 'SKILL.md')), ['Codex', 'Vibe']);
    assert.deepEqual(agentsOf(join(code, 'app', '.agents', 'skills', 'app-deploy', 'SKILL.md')), ['Codex', 'Vibe']);
    assert.deepEqual(agentsOf(join(home, '.vibe', 'skills', 'vibe-only', 'SKILL.md')), ['Vibe']);
  });

  it('should leave Vibe out of projects it does not trust', () => {
    const { files } = scan(config()).inventory;
    assert.deepEqual(files.find(f => f.path.includes('shady-deploy'))?.skill?.agents, ['Codex']);
  });
});

describe('a skill listed twice', () => {
  it('should flag the leftover link and remove it with undo', () => {
    const store = new Store(join(home, '.data-twice'));
    store.saveInventory(scan(config()).inventory);
    const finding = analyze(store.inventory() as Inventory).findings.find(f => f.kind === 'listed-twice');
    const extra = join(home, '.codex', 'skills', 'work-ticket');
    assert.ok(finding, 'Codex reaches work-ticket through ~/.codex/skills and ~/.agents/skills');
    assert.deepEqual(finding.agents, ['Codex']);
    assert.deepEqual(finding.extraLinks, [extra], 'only the link Codex does not need, never the real folder');
    const actions = new Actions(store, config());
    const reply = actions.removeLink(finding.id, extra);
    assert.ok(!isLink(extra) && existsSync(shared), 'the link is gone and the skill folder stays');
    assert.ok(!actions.current().findings.some(f => f.kind === 'listed-twice'));
    actions.undo(reply.undo ?? []);
    assert.ok(isLink(extra), 'undo puts the link back');
  });

  it('should refuse a path that is not one of the extra links', () => {
    const store = new Store(join(home, '.data-refuse'));
    store.saveInventory(scan(config()).inventory);
    const actions = new Actions(store, config());
    const finding = actions.current().findings.find(f => f.kind === 'listed-twice')!;
    assert.throws(() => actions.removeLink(finding.id, shared), /not part of this issue/);
  });
});

describe('sharing a skill with more agents', () => {
  it('should offer only installed agents that miss it, and link it with undo', () => {
    const store = new Store(join(home, '.data-share'));
    store.saveInventory(scan(config()).inventory);
    const actions = new Actions(store, config());
    const thing = actions.current().things.find(t => t.name === 'work-ticket')!;
    assert.deepEqual(thing.share?.map(s => s.agent), ['Gemini'], 'Claude has a link, Vibe reads skill_paths, Codex reads ~/.agents/skills');
    const target = join(home, '.gemini', 'skills', 'work-ticket');
    const reply = actions.shareSkill(thing.id, ['Gemini']);
    assert.equal(realpathSync(target), shared, 'a link to the same folder, not a copy');
    assert.ok(!actions.current().things.find(t => t.name === 'work-ticket')?.share, 'nothing left to share');
    actions.undo(reply.undo ?? []);
    assert.ok(!isLink(target) && existsSync(shared), 'undo removes only the link');
  });

  it('should not offer agents the user turned off', () => {
    const store = new Store(join(home, '.data-off'));
    store.saveInventory(scan(config()).inventory);
    const actions = new Actions(store, { ...config(), agents: ['Claude', 'Codex'] });
    const thing = actions.current().things.find(t => t.name === 'work-ticket')!;
    assert.throws(() => actions.shareSkill(thing.id, ['Gemini']), /already sees/);
  });
});
