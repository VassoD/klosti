import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ActionRefused, backUp, locateLine, restore } from '../src/actions.ts';
import { analyze } from '../src/analyze.ts';
import { verbatim } from '../src/review.ts';
import { usesInLog } from '../src/usage.ts';
import { EXCLUDED_DIRS, type ResolvedConfig } from '../src/config.ts';
import { frontmatter, redact, scan } from '../src/scan.ts';
import { Store } from '../src/store.ts';
import type { Inventory } from '../src/types.ts';

const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const skill = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nSteps.\n`;

describe('frontmatter', () => {
  it('should read plain and folded values', () => {
    const meta = frontmatter('---\nname: deploy\ndescription: >\n  Ships the app\n  to production\ndisable-model-invocation: true\n---\nbody');
    assert.equal(meta.name, 'deploy');
    assert.equal(meta.description, 'Ships the app to production');
    assert.equal(meta['disable-model-invocation'], 'true');
  });

  it('should return nothing when there is no front matter', () => {
    assert.deepEqual(frontmatter('# Title\ntext'), {});
  });
});

describe('redact', () => {
  it('should mask credential assignments and long tokens', () => {
    const out = redact('API_KEY=abc123 node run.js --token sk_live_0123456789abcdefghijklmnopqrstuvwxyz');
    assert.ok(out.includes('API_KEY=•••'), out);
    assert.ok(!out.includes('0123456789abcdefghijklmnopqrstuvwxyz'), out);
  });
});

describe('locateLine', () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'klosti-lines-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('should find a line despite markdown and punctuation differences', () => {
    const file = join(dir, 'a.md');
    writeFileSync(file, '# Rules\n- Use **React Query** for server state\n- Keep it short\n');
    assert.equal(locateLine(file, 'Use React Query for server state.').index, 1);
  });

  it('should refuse when the text is on several lines', () => {
    const file = join(dir, 'b.md');
    writeFileSync(file, '- Use tabs\n- Use tabs\n');
    assert.throws(() => locateLine(file, 'Use tabs'), ActionRefused);
  });

  it('should refuse when the line is gone', () => {
    const file = join(dir, 'c.md');
    writeFileSync(file, '- Something else entirely\n');
    assert.throws(() => locateLine(file, 'Never use semicolons in TypeScript files'), ActionRefused);
  });
});

describe('verbatim', () => {
  it('should keep quoted instructions and drop paraphrases', () => {
    const body = '# Ship\n- **Always** commit after each step\n- Run the tests first\n';
    assert.deepEqual(verbatim(body, ['Always commit after each step', 'Commit often', 'Run the tests first', 'Run the tests first']), ['Always commit after each step', 'Run the tests first']);
  });
});

describe('usesInLog', () => {
  const line = (entry: object): string => JSON.stringify({ sessionId: 's1', cwd: '/code/app', timestamp: '2026-10-01T10:00:00Z', ...entry });
  const tool = (name: string, input: object): string => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

  it('should credit files written after a skill to that skill, and skip built-in commands', () => {
    const log = [
      tool('Write', { file_path: '/code/app/before.ts', content: 'secret text' }),
      tool('Skill', { skill: 'writing-plans', args: 'private request' }),
      tool('Write', { file_path: '/code/app/plan.md', content: 'x' }),
      tool('Edit', { file_path: '/code/app/plan.md', old_string: 'a', new_string: 'b' }),
      line({ type: 'user', message: { content: '<command-name>/model</command-name>' } }),
      tool('Edit', { file_path: '/code/app/src.ts', old_string: 'a', new_string: 'b' }),
      line({ type: 'user', message: { content: '<command-name>/deploy</command-name>' } }),
      tool('Write', { file_path: '/code/app/out.txt', content: 'x' }),
    ].join('\n');
    const uses = usesInLog(log);
    assert.deepEqual(uses.map(u => [u.skill, u.by]), [['writing-plans', 'claude'], ['deploy', 'you']]);
    assert.deepEqual(uses[0]?.files, [{ path: '/code/app/plan.md', action: 'wrote' }, { path: '/code/app/src.ts', action: 'edited' }]);
    assert.ok(!JSON.stringify(uses).includes('secret') && !JSON.stringify(uses).includes('private'), 'no message or file text is kept');
  });
});

describe('backups', () => {
  it('should restore a file byte for byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klosti-backup-'));
    try {
      const store = new Store(join(dir, 'data'));
      const file = join(dir, 'CLAUDE.md');
      writeFileSync(file, 'original\n');
      const id = backUp(store, file);
      writeFileSync(file, 'changed\n');
      restore(store, id);
      assert.equal(readFileSync(file, 'utf8'), 'original\n');
      assert.throws(() => restore(store, 'missing'), ActionRefused);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('scan and analyze a fixture workspace', () => {
  let root: string;
  let inventory: Inventory;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'klosti-fixture-'));
    const app = join(root, 'app');
    mkdirSync(join(app, '.git'), { recursive: true });
    write(join(app, 'CLAUDE.md'), '# App rules\n- Use pnpm\n');
    write(join(app, 'AGENTS.md'), '# Agent rules\n- Use npm\n');
    write(join(app, '.agents', 'skills', 'deploy', 'SKILL.md'), skill('deploy', 'Deploy the app to production'));
    write(join(app, 'web', '.agents', 'skills', 'deploy', 'SKILL.md'), skill('deploy', 'Deploy only the web front end'));
    mkdirSync(join(app, '.claude', 'skills'), { recursive: true });
    symlinkSync(join('..', '..', '.agents', 'skills', 'deploy'), join(app, '.claude', 'skills', 'deploy'));
    write(join(app, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'TOKEN=supersecret ./lint.sh' }] }] } }));
    write(join(app, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['@acme/docs-mcp', '--key', 'abcdefghijklmnopqrstuvwxyz0123456789'], env: { KEY: 'secret' } } } }));
    write(join(app, 'node_modules', 'pkg', 'CLAUDE.md'), 'ignored');
    const config: ResolvedConfig = { codeRoots: [root], agentRoots: [], excluded: EXCLUDED_DIRS, ignored: [], agents: [], onboarded: true, dataDir: join(root, '.data') };
    inventory = scan(config).inventory;
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const mine = (path: string): boolean => path.startsWith(root);

  it('should find rules and skills but skip excluded folders', () => {
    const rules = inventory.files.filter(f => f.family !== 'Skill' && mine(f.path)).map(f => f.path.slice(root.length));
    assert.deepEqual(rules.sort(), ['/app/AGENTS.md', '/app/CLAUDE.md']);
  });

  it('should follow a symlinked skill folder and record its target', () => {
    const linked = inventory.files.find(f => f.path.includes('/.claude/skills/deploy/'));
    assert.ok(linked?.linkTarget?.endsWith('/.agents/skills/deploy/SKILL.md'));
    assert.equal(linked?.skill?.agent, 'Claude');
  });

  it('should skip a folder the user ignored', () => {
    const config: ResolvedConfig = { codeRoots: [root], agentRoots: [], excluded: EXCLUDED_DIRS, ignored: [join(root, 'app', 'web')], agents: [], onboarded: true, dataDir: join(root, '.data') };
    const paths = scan(config).inventory.files.filter(f => mine(f.path)).map(f => f.path);
    assert.ok(paths.some(p => p.endsWith('/app/CLAUDE.md')), 'the rest of the project is still scanned');
    assert.ok(!paths.some(p => p.includes('/app/web/')), 'nothing inside the ignored folder is scanned');
  });

  it('should never copy MCP environment variables or secret arguments', () => {
    const server = inventory.extras.mcp.find(m => m.name === 'docs');
    assert.equal(server?.target, 'npx @acme/docs-mcp');
    assert.ok(!JSON.stringify(inventory.extras.mcp).includes('secret'));
  });

  it('should mask secrets in hook commands', () => {
    const hook = inventory.extras.hooks.find(h => mine(h.path));
    assert.equal(hook?.command, 'TOKEN=••• ./lint.sh');
  });

  it('should merge identical skill copies and flag same-name skills and agent drift', () => {
    const analysis = analyze(inventory);
    const deploy = analysis.things.filter(t => t.kind === 'skill' && t.paths.some(mine) && t.name === 'deploy');
    assert.equal(deploy.length, 2, 'the symlinked copy merges with its original');
    assert.ok(deploy.some(t => t.agents.includes('Claude') && t.agents.includes('Codex')));
    const kinds = analysis.findings.filter(f => f.items.some(id => deploy.some(t => t.id === id)) || f.kind === 'drift').map(f => f.kind);
    assert.ok(kinds.includes('same-name'), `findings: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('drift'), `findings: ${kinds.join(', ')}`);
  });

  it('should report a contradiction between a skill and a rule from the review cache', () => {
    const plain = analyze(inventory);
    const stack = plain.instructionStacks.find(s => s.agent === 'Claude' && s.focus.length && s.rules.length);
    assert.ok(stack, 'the project has a place where a skill loads next to a rule');
    const deploySkill = plain.things.find(t => stack.skills.includes(t.id))!;
    const claudeMd = plain.things.find(t => stack.rules.includes(t.id))!;
    const conflict = { title: 'Package manager differs', files: [claudeMd.paths[0]!, deploySkill.paths[0]!], quotes: [{ file: deploySkill.paths[0]!, text: 'Steps.' }], explanation: 'x', happens: 'y', advice: 'z' };
    const reviewed = analyze(inventory, { instructions: { [stack.key]: { conflicts: [conflict], at: '', model: '' } } });
    const found = reviewed.findings.find(f => f.kind === 'contradiction' && f.title === 'Package manager differs');
    assert.ok(found?.items.includes(deploySkill.id), 'the skill is part of the finding');
    assert.ok(found?.items.includes(claudeMd.id), 'the rule is part of the finding');
  });
});
