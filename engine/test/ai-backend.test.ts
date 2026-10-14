import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { z } from 'zod';

// The engine reads the home folder when it loads, so point HOME and PATH at a fixture first.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'klosti-ai-')));
const bin = join(home, 'bin');
process.env.HOME = home;
process.env.PATH = bin;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
const { aiAvailability, askAi, dropNulls, extractJson, setExtraCliDirs, setProcessRunner, strictSchema } = await import('../src/ai.ts');
setExtraCliDirs([]);

const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
/** Only the file's existence matters: no test starts a real CLI. */
const install = (...names: string[]): void => { for (const name of names) { write(join(bin, name), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, name), 0o755); } };
const choose = (backend: string | null): void => write(join(home, '.config', 'klosti', 'config.json'), JSON.stringify(backend ? { aiBackend: backend } : {}));
const Answer = z.object({ title: z.string(), likelyPick: z.string().optional() });

afterEach(() => { rmSync(bin, { recursive: true, force: true }); choose(null); setProcessRunner(null); });
after(() => rmSync(home, { recursive: true, force: true }));

describe('AI backend choice', () => {
  it('should report no backend when nothing is installed', async () => {
    assert.equal(aiAvailability().via, null);
    await assert.rejects(askAi('hi', Answer), /Install Claude Code, Codex or Mistral Vibe/);
  });

  it('should keep Claude Code first when nothing is chosen', () => {
    install('claude', 'codex', 'vibe');
    assert.equal(aiAvailability().via, 'claude-code');
  });

  it('should use the chosen backend when it is installed', () => {
    install('claude', 'codex');
    choose('codex');
    assert.equal(aiAvailability().via, 'codex');
    assert.match(aiAvailability().detail, /uses Codex/);
  });

  it('should fall back and say so when the chosen backend is missing', () => {
    install('vibe');
    choose('codex');
    const ai = aiAvailability();
    assert.equal(ai.via, 'vibe');
    assert.match(ai.detail, /Codex is not installed, so Mistral Vibe is used/);
  });
});

describe('Codex backend', () => {
  it('should run codex exec read-only with a strict schema and read the answer file', async () => {
    install('codex');
    let seen: { args: string[]; input: string; schema: Record<string, unknown> } | null = null;
    setProcessRunner(async (_cmd, args, input) => {
      const schema = JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1]!, 'utf8')) as Record<string, unknown>;
      seen = { args, input, schema };
      writeFileSync(args[args.indexOf('--output-last-message') + 1]!, '{"title":"Merge them","likelyPick":null}');
      return { code: 0, stdout: '', stderr: '' };
    });
    const result = await askAi('Compare these skills', Answer);
    assert.deepEqual(result.value, { title: 'Merge them' }, 'the null for an optional field is dropped');
    assert.equal(result.via, 'codex');
    const { args, input, schema } = seen!;
    for (const flag of ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(input, 'Compare these skills', 'the prompt goes through stdin');
    assert.deepEqual(schema.required, ['title', 'likelyPick']);
    assert.equal(schema.additionalProperties, false);
  });
});

describe('Mistral Vibe backend', () => {
  it('should run vibe with every tool off and parse the JSON from the last answer', async () => {
    install('vibe');
    let seen: { args: string[]; input: string } | null = null;
    setProcessRunner(async (_cmd, args, input) => {
      seen = { args, input };
      const messages = [{ role: 'user', content: input }, { role: 'assistant', content: 'Here you go:\n```json\n{"title":"Keep both"}\n```' }];
      return { code: 0, stdout: JSON.stringify(messages), stderr: '' };
    });
    const result = await askAi('Compare these skills', Answer);
    assert.deepEqual(result.value, { title: 'Keep both' });
    const { args, input } = seen!;
    assert.equal(args[0], '-p');
    assert.equal(args[args.indexOf('--output') + 1], 'json');
    assert.equal(args[args.indexOf('--max-turns') + 1], '1');
    assert.ok(args.includes('--enabled-tools'), 'tools are limited to a name that matches none');
    assert.match(input, /Compare these skills[\s\S]*JSON Schema/, 'the prompt carries the schema, since Vibe cannot enforce one');
  });
});

describe('answer parsing helpers', () => {
  it('should find JSON in plain, fenced or surrounded text', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(extractJson('Sure. {"a":3} Done.'), { a: 3 });
    assert.throws(() => extractJson('no json here'), /no JSON/);
  });

  it('should drop nulls at every depth', () => {
    assert.deepEqual(dropNulls({ a: null, b: [{ c: null, d: 1 }] }), { b: [{ d: 1 }] });
  });

  it('should make every property required and allow null for the optional ones', () => {
    const schema = strictSchema(z.toJSONSchema(Answer)) as { required: string[]; properties: Record<string, unknown> };
    assert.deepEqual(schema.required, ['title', 'likelyPick']);
    assert.deepEqual(schema.properties.likelyPick, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  });
});
