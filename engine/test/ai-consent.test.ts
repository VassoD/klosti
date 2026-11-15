import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { z } from 'zod';

// The engine reads the home folder when it loads, so point HOME, PATH and the model at a fixture first.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'klosti-consent-')));
const bin = join(home, 'bin');
process.env.HOME = home;
process.env.PATH = bin;
process.env.KLOSTI_SEARCH_PATH = bin;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.KLOSTI_MODEL;
delete process.env.AGENT_RULEBOOK_MODEL;
const { AiConsentRequiredError, aiAvailability, aiModel, askAi, requireAiConsent, setExtraCliDirs, setProcessRunner } = await import('../src/ai.ts');
const { Actions } = await import('../src/actions.ts');
const { AGENT_DIRS, CONFIG_PATH, distinctFolders, EXCLUDED_DIRS, saveUserSettings } = await import('../src/config.ts');
const { Store } = await import('../src/store.ts');
type ResolvedConfig = import('../src/config.ts').ResolvedConfig;
setExtraCliDirs([]);

const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
/** Only the file's existence matters: no test starts a real CLI. */
const install = (...names: string[]): void => { for (const name of names) { write(join(bin, name), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, name), 0o755); } };
const config = (): ResolvedConfig => ({ codeRoots: [], agentRoots: AGENT_DIRS.map(d => join(home, d)), excluded: EXCLUDED_DIRS, ignored: [], agents: [], onboarded: true, dataDir: join(home, '.data') });
const actions = (): InstanceType<typeof Actions> => new Actions(new Store(join(home, '.data')), config());
const Answer = z.object({ title: z.string() });

afterEach(() => { rmSync(bin, { recursive: true, force: true }); rmSync(CONFIG_PATH, { force: true }); setProcessRunner(null); });
after(() => rmSync(home, { recursive: true, force: true }));

describe('AI consent', () => {
  it('should not allow any tool until the user says so', () => {
    install('claude');
    const ai = aiAvailability();
    assert.equal(ai.via, 'claude-code');
    assert.equal(ai.consented, false);
    assert.match(ai.provider ?? '', /Anthropic/, 'the question names who receives the files');
    assert.throws(() => requireAiConsent(), AiConsentRequiredError);
  });

  it('should refuse an AI fix before the user allows the tool', async () => {
    install('claude');
    await assert.rejects(actions().proposeFix('any-finding'), AiConsentRequiredError, 'consent is checked before any file is read');
  });

  it('should allow only the tool the user allowed', () => {
    install('claude', 'codex');
    actions().setAiConsent('codex', true);
    assert.equal(aiAvailability().consented, false, 'Claude Code is in use and was not allowed');
    assert.deepEqual(aiAvailability().consents, ['codex']);
    saveUserSettings({ aiBackend: 'codex' });
    assert.equal(aiAvailability().consented, true);
    assert.equal(requireAiConsent(), 'codex');
  });

  it('should ask again after the user stops a tool', () => {
    install('claude');
    const act = actions();
    act.setAiConsent('claude-code', true);
    assert.equal(aiAvailability().consented, true);
    act.setAiConsent('claude-code', false);
    assert.equal(aiAvailability().consented, false);
  });

  it('should refuse a tool it does not know', () => {
    assert.throws(() => actions().setAiConsent('gpt', true), /Pick Claude Code/);
  });
});

describe('AI model', () => {
  it('should use Opus by default', () => {
    install('claude');
    assert.equal(aiModel(), 'claude-opus-5-5');
    assert.equal(aiAvailability().model, 'claude-opus-5-5');
  });

  it('should pass the model chosen in Settings to Claude Code', async () => {
    install('claude');
    actions().setAiModel('claude-sonnet-5-5');
    let model: string | undefined;
    setProcessRunner(async (_cmd, args) => {
      model = args[args.indexOf('--model') + 1];
      return { code: 0, stdout: JSON.stringify({ structured_output: { title: 'ok' } }), stderr: '' };
    });
    const result = await askAi('hi', Answer);
    assert.equal(model, 'claude-sonnet-5-5');
    assert.equal(result.model, 'claude-sonnet-5-5', 'the review records which model answered');
  });

  it('should leave the model to Codex and Vibe', () => {
    install('codex');
    assert.equal(aiAvailability().model, null);
  });

  it('should refuse a model it does not offer', () => {
    assert.throws(() => actions().setAiModel('gpt-5'), /Pick Opus 5.5 or Sonnet 5.5/);
  });
});

describe('code folders', () => {
  it('should list a folder once when two default names reach it, as ~/code and ~/Code do on macOS', () => {
    mkdirSync(join(home, 'code'), { recursive: true });
    assert.deepEqual(distinctFolders([join(home, 'code'), join(home, 'Code')]), [join(home, 'code')]);
  });

  it('should keep a linked folder at its own path, so project paths do not move', () => {
    mkdirSync(join(home, 'elsewhere', 'repos'), { recursive: true });
    symlinkSync(join(home, 'elsewhere', 'repos'), join(home, 'work'));
    assert.deepEqual(distinctFolders([join(home, 'work')]), [join(home, 'work')]);
  });

  it('should skip folders that do not exist', () => {
    assert.deepEqual(distinctFolders([join(home, 'nowhere')]), []);
  });
});
