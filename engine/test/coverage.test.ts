import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The engine reads agent folders from the home folder when it loads, so point HOME at a fixture first.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'klosti-coverage-')));
process.env.HOME = home;
const bin = join(home, 'bin');
process.env.KLOSTI_SEARCH_PATH = bin;
const { analyze } = await import('../src/analyze.ts');
const { AGENT_DIRS, EXCLUDED_DIRS, installedAgents } = await import('../src/config.ts');
const { scan } = await import('../src/scan.ts');
type ResolvedConfig = import('../src/config.ts').ResolvedConfig;
type Analysis = import('../src/types.ts').Analysis;

const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const code = join(home, 'code');
const project = (name: string, files: Record<string, string>): void => {
  mkdirSync(join(code, name, '.git'), { recursive: true });
  for (const [file, text] of Object.entries(files)) write(join(code, name, file), text);
};
const config = (): ResolvedConfig => ({ codeRoots: [code], agentRoots: AGENT_DIRS.map(d => join(home, d)).filter(p => existsSync(p)), excluded: EXCLUDED_DIRS, ignored: [], agents: [], onboarded: true, dataDir: join(home, '.data') });
const skill = (name: string): string => `---\nname: ${name}\ndescription: Shared skill ${name}\n---\n\nSteps.\n`;

let result: Analysis;
const rule = (path: string) => result.things.find(t => t.kind === 'rule' && t.paths.includes(path));

before(() => {
  write(join(home, '.agents', 'skills', 'shared', 'SKILL.md'), skill('shared'));
  mkdirSync(join(home, '.gemini'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  write(join(bin, 'claude'), '');
  mkdirSync(join(bin, 'Cursor.app'), { recursive: true });

  write(join(home, '.codex', 'config.toml'), 'project_doc_max_bytes = 200\nproject_doc_fallback_filenames = ["TEAM_GUIDE.md"]\n');
  write(join(home, '.codex', 'AGENTS.md'), '# Global\nKeep answers short.\n');
  project('big', { 'AGENTS.md': `# Big\n${'Follow the house style. '.repeat(12)}\n` });
  project('small', { 'AGENTS.md': '# Small\nRun the tests.\n' });
  project('override', { 'AGENTS.override.md': '# Override\nUse pnpm.\n', 'AGENTS.md': '# Base\nUse npm.\n' });
  project('emptyover', { 'AGENTS.override.md': '', 'AGENTS.md': '# Base\nUse yarn.\n' });
  project('guide', { 'TEAM_GUIDE.md': '# Team guide\nWrite tests first.\n' });
  project('both', { 'AGENTS.md': '# Both\nLint before commit.\n', 'TEAM_GUIDE.md': '# Unused guide\nNever read.\n' });

  write(join(home, '.vibe', 'config.toml'), '');
  write(join(home, '.vibe', 'trusted_folders.toml'), `trusted = []\nuntrusted = ["${join(code, 'shady')}"]\n`);
  write(join(home, '.vibe', 'agents', 'redteam.toml'), 'agent_type = "subagent"\ndisplay_name = "Red team"\ndescription = "Looks for security holes"\nactive_model = "devstral-2"\nenabled_tools = ["grep", "read_file"]\n');
  write(join(home, '.vibe', 'agents', 'planner.toml'), 'agent_type = "agent"\ndisplay_name = "Planner"\n');
  project('shady', { '.vibe/agents/sneaky.toml': 'agent_type = "subagent"\ndescription = "Untrusted"\n' });

  result = analyze(scan(config()).inventory);
});

after(() => rmSync(home, { recursive: true, force: true }));

describe('installed agents', () => {
  it('should count an agent by its command or app, not by its home folder', () => {
    assert.deepEqual(installedAgents(), ['Claude', 'Cursor'], 'claude is a command, Cursor.app an app; ~/.gemini alone is not an install');
  });

  it('should not offer to share a skill with an agent that is not installed', () => {
    const shared = result.things.find(t => t.kind === 'skill' && t.name === 'shared')!;
    assert.deepEqual(shared.share?.map(s => s.agent), ['Claude'], 'Gemini has a folder but no command, Vibe is not installed either');
  });
});

describe('Codex instruction files', () => {
  it('should read AGENTS.override.md instead of AGENTS.md in the same folder', () => {
    assert.deepEqual(rule(join(code, 'override', 'AGENTS.override.md'))?.agents, ['Codex'], 'only Codex reads the override');
    assert.ok(!rule(join(code, 'override', 'AGENTS.md'))?.agents.includes('Codex'), 'Codex skips AGENTS.md when an override exists');
  });

  it('should fall back to AGENTS.md when the override is empty', () => {
    assert.ok(rule(join(code, 'emptyover', 'AGENTS.md'))?.agents.includes('Codex'), 'Codex skips empty files');
  });

  it('should find fallback file names from config.toml and give them to Codex only when nothing comes first', () => {
    assert.deepEqual(rule(join(code, 'guide', 'TEAM_GUIDE.md'))?.agents, ['Codex']);
    assert.deepEqual(rule(join(code, 'both', 'TEAM_GUIDE.md'))?.agents, [], 'AGENTS.md comes first, so nothing loads the guide');
  });

  it('should flag a project whose instructions go over project_doc_max_bytes', () => {
    const tooLong = result.findings.filter(f => f.kind === 'too-long');
    assert.equal(tooLong.length, 1, 'only big goes over 200 bytes with the global file');
    assert.deepEqual(tooLong[0]?.agents, ['Codex']);
    assert.match(tooLong[0]?.title ?? '', /in big$/);
    assert.equal(tooLong[0]?.items.length, 2, 'the chain is the global file plus the project file');
  });
});

describe('Mistral Vibe agents', () => {
  it('should list agent files as Vibe subagents named after the file', () => {
    const redteam = result.things.find(t => t.kind === 'subagent' && t.name === 'redteam');
    assert.deepEqual(redteam?.agents, ['Vibe']);
    assert.equal(redteam?.description, 'Looks for security holes');
    assert.equal(redteam?.model, 'devstral-2');
    const planner = result.things.find(t => t.kind === 'subagent' && t.name === 'planner');
    assert.match(planner?.description ?? '', /^Planner\. Picked with vibe --agent/);
  });

  it('should skip agents in folders Vibe does not trust', () => {
    assert.ok(!result.things.some(t => t.name === 'sneaky'));
  });
});
