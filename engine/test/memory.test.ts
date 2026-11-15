import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

// The engine reads agent folders from the home folder when it loads, so point HOME at a fixture first.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'klosti-memory-')));
process.env.HOME = home;
process.env.KLOSTI_SEARCH_PATH = join(home, 'bin');
const { AGENT_DIRS, EXCLUDED_DIRS } = await import('../src/config.ts');
const { encodeProjectKey, projectFolderFor, scan } = await import('../src/scan.ts');
const { analyze } = await import('../src/analyze.ts');
type ResolvedConfig = import('../src/config.ts').ResolvedConfig;
type Inventory = import('../src/types.ts').Inventory;

const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const code = join(home, 'side-projects');
const project = join(code, 'my.app');
const memoryDir = (folder: string): string => join(home, '.claude', 'projects', encodeProjectKey(folder), 'memory');
const config = (ignored: string[] = []): ResolvedConfig => ({ codeRoots: [code], agentRoots: AGENT_DIRS.map(d => join(home, d)).filter(p => existsSync(p)), excluded: EXCLUDED_DIRS, ignored, agents: [], onboarded: true, dataDir: join(home, '.data') });
const topic = (name: string, body: string): string => `---\nname: ${name}\ndescription: "Ask before pushing"\nmetadata:\n  node_type: memory\n  type: feedback\n---\n\n${body}\n`;

write(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
write(join(project, 'CLAUDE.md'), '# My app\nRun the tests before committing.\n');
write(join(memoryDir(project), 'MEMORY.md'), '- [No push without approval](no-push.md), ask first\n');
write(join(memoryDir(project), 'no-push.md'), topic('no-push-without-approval', 'Never push without approval.'));
write(join(memoryDir(join(code, 'deleted-project')), 'MEMORY.md'), '- [Old](old.md)\n');

after(() => rmSync(home, { recursive: true, force: true }));

const memoryFiles = (inventory: Inventory): Inventory['files'] => inventory.files.filter(f => f.family === 'Memory');

describe('projectFolderFor', () => {
  it('should find the folder behind a key whose path has dashes and dots', () => {
    assert.equal(projectFolderFor(encodeProjectKey(project)), project);
  });

  it('should return null when the folder no longer exists', () => {
    assert.equal(projectFolderFor(encodeProjectKey(join(code, 'deleted-project'))), null);
  });
});

describe('memory scan', () => {
  it('should read the memory index and topic files into the project they belong to', () => {
    const { inventory } = scan(config());
    const files = memoryFiles(inventory);
    assert.deepEqual(files.map(f => f.memory?.name).sort(), ['Memory index', 'no-push-without-approval']);
    for (const f of files) {
      assert.equal(f.scope, 'Folder', 'a memory only loads in its own project');
      assert.equal(f.folder, project);
    }
    const noPush = files.find(f => !f.memory?.index);
    assert.equal(noPush?.memory?.type, 'feedback', 'the type nested under metadata is read');
    assert.equal(noPush?.memory?.description, 'Ask before pushing');
  });

  it('should list a memory folder whose project is gone without reading it', () => {
    const { inventory } = scan(config());
    const gone = inventory.memories.find(m => m.projectKey === encodeProjectKey(join(code, 'deleted-project')));
    assert.equal(gone?.folder, null);
    assert.ok(!inventory.files.some(f => f.path.startsWith(dirname(gone?.path ?? ''))), 'nothing from it is read');
  });

  it('should skip memories of a project the user stopped scanning', () => {
    const { inventory } = scan(config([project]));
    assert.equal(memoryFiles(inventory).length, 0);
  });

  it('should not list existing memories as added on the first scan that reads them', () => {
    const { inventory: before } = scan(config());
    const older: Partial<Inventory> = { ...before, files: before.files.filter(f => f.family !== 'Memory'), memoriesTracked: undefined };
    const { inventory, changes } = scan(config(), older);
    assert.ok(!changes.added.some(c => c.kind === 'memory'), 'memories are not reported as new');
    for (const f of memoryFiles(inventory)) assert.equal(f.firstSeen, before.baselineAt, 'they date from the baseline, so they are not marked New');
  });

  it('should report a later memory edit as a changed memory with its lines', () => {
    const { inventory: first } = scan(config());
    write(join(memoryDir(project), 'no-push.md'), topic('no-push-without-approval', 'Push small fixes once the commit is approved.'));
    const { changes } = scan(config(), first);
    const change = changes.changed.find(c => c.kind === 'memory');
    assert.equal(change?.agent, 'Claude');
    assert.deepEqual([change?.linesAdded, change?.linesRemoved], [1, 1]);
  });
});

describe('memory analysis', () => {
  it('should treat memories as Claude rules in their project, with only the index loaded every session', () => {
    const { inventory } = scan(config());
    const { things, stacks } = analyze(inventory);
    const memories = things.filter(t => t.family === 'Memory');
    const index = memories.find(t => t.loadsWhen === 'start');
    const recalled = memories.find(t => t.loadsWhen === 'recall');
    assert.ok(index && recalled, 'both the index and the topic file are listed');
    assert.equal(recalled.kind, 'rule');
    assert.deepEqual(recalled.agents, ['Claude']);
    assert.equal(recalled.memoryType, 'feedback');
    assert.ok(!recalled.body.includes('node_type'), 'front matter is not part of the text');
    assert.deepEqual(recalled.projects.map(p => p.path), [project]);
    const stack = stacks.find(s => s.project === project && s.agent === 'Claude');
    const claudeMd = things.find(t => t.paths.includes(join(project, 'CLAUDE.md')));
    assert.ok(stack?.rules.includes(recalled.id) && stack.rules.includes(claudeMd?.id ?? ''), 'the AI review checks memories against CLAUDE.md');
  });
});
