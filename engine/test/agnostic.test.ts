import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The engine reads agent folders from the home folder when it loads, so point HOME at a fixture first.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'klosti-agnostic-')));
process.env.HOME = home;
const { analyze } = await import('../src/analyze.ts');
const { AGENT_DIRS, EXCLUDED_DIRS } = await import('../src/config.ts');
const { scan } = await import('../src/scan.ts');
type ResolvedConfig = import('../src/config.ts').ResolvedConfig;

const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const code = join(home, 'code');
const config = (): ResolvedConfig => ({ codeRoots: [code], agentRoots: AGENT_DIRS.map(d => join(home, d)).filter(p => existsSync(p)), excluded: EXCLUDED_DIRS, ignored: [], agents: [], onboarded: true, dataDir: join(home, '.data') });

before(() => {
  write(join(home, '.vibe', 'config.toml'), '[[mcp_servers]]\nname = "docs"\ntransport = "stdio"\ncommand = "docs-mcp"\n');
  write(join(home, '.vibe', 'hooks.toml'), '[[hooks]]\nname = "fmt"\ntype = "post_tool"\nmatch = "write_file"\ncommand = "prettier --write"\n');
  write(join(home, '.vibe', 'trusted_folders.toml'), `trusted = []\nuntrusted = ["${join(code, 'shady')}"]\n`);
  write(join(home, '.vibe', 'AGENTS.md'), '# Vibe global\nUse tabs.\n');
  write(join(home, '.codex', 'config.toml'), '[mcp_servers.search]\ncommand = "search-a"\n');
  for (const name of ['app', 'shady']) {
    mkdirSync(join(code, name, '.git'), { recursive: true });
    write(join(code, name, 'AGENTS.md'), `# ${name}\nRun the tests.\n`);
    write(join(code, name, 'CLAUDE.md'), `# ${name} for Claude\nUse pnpm.\n`);
  }
  write(join(code, 'app', '.codex', 'config.toml'), '[mcp_servers.search]\ncommand = "search-b"\n');
});
after(() => rmSync(home, { recursive: true, force: true }));

describe('agent-agnostic analysis', () => {
  it('should credit AGENTS.md to every agent that reads it', () => {
    const { things } = analyze(scan(config()).inventory);
    const agentsOf = (path: string): string[] | undefined => things.find(t => t.kind === 'rule' && t.paths.includes(path))?.agents;
    assert.deepEqual(agentsOf(join(home, '.vibe', 'AGENTS.md')), ['Vibe'], 'Vibe global file');
    assert.deepEqual(agentsOf(join(code, 'app', 'AGENTS.md')), ['Codex', 'Vibe'], 'trusted project');
    assert.deepEqual(agentsOf(join(code, 'shady', 'AGENTS.md')), ['Codex'], 'Vibe skips untrusted folders');
  });

  it('should scan Mistral Vibe MCP servers and hooks', () => {
    const { extras } = scan(config()).inventory;
    assert.ok(extras.mcp.some(m => m.agent === 'Vibe' && m.name === 'docs' && m.target.includes('docs-mcp')), JSON.stringify(extras.mcp));
    assert.ok(extras.hooks.some(h => h.agent === 'Vibe' && h.event === 'post_tool' && h.matcher === 'write_file'), JSON.stringify(extras.hooks));
  });

  it('should name every AGENTS.md reader when CLAUDE.md does not import it', () => {
    const drift = analyze(scan(config()).inventory).findings.filter(f => f.kind === 'drift');
    const app = drift.find(f => f.title.endsWith(' app'));
    assert.equal(app?.title, 'Claude, Codex and Mistral Vibe get different instructions in app');
    assert.ok(app?.happens.includes('Codex and Mistral Vibe read only AGENTS.md'), app?.happens);
  });

  it('should flag an MCP server configured twice for Codex without inventing a winner', () => {
    const twice = analyze(scan(config()).inventory).findings.find(f => f.title === 'MCP server “search” is configured twice for Codex');
    assert.ok(twice, 'finding exists');
    assert.ok(twice.happens.includes('docs do not say which entry wins'), twice.happens);
    assert.equal(twice.winner ?? null, null);
  });

  it('should not estimate a skill listing budget for agents that document none', () => {
    const { budgets } = analyze(scan(config()).inventory);
    assert.ok(!budgets.some(b => b.agent === 'Vibe'), JSON.stringify(budgets.map(b => b.agent)));
  });
});
