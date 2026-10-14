import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import { HOME, readAiBackend } from './config.ts';

/** Override with KLOSTI_MODEL, for example claude-sonnet-5-5 for lower cost. Codex and Vibe use their own default model. */
export const AI_MODEL = process.env.KLOSTI_MODEL ?? process.env.AGENT_RULEBOOK_MODEL ?? 'claude-opus-5-5';
const MAX_TOKENS = 16000;
const CALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Vibe has no schema option, so the prompt carries the schema and one turn is enough to answer. */
const VIBE_MAX_TURNS = '1';
/** A tool name that matches nothing: in Vibe's programmatic mode, --enabled-tools turns every other tool off. */
const VIBE_NO_TOOLS = 'klosti-no-tools';

export const AI_BACKENDS = ['claude-code', 'api', 'codex', 'vibe'] as const;
export type AiBackend = typeof AI_BACKENDS[number];
export const AI_BACKEND_LABELS: Record<AiBackend, string> = { 'claude-code': 'Claude Code', api: 'Anthropic API', codex: 'Codex', vibe: 'Mistral Vibe' };

export class AiUnavailableError extends Error {
  override name = 'AiUnavailableError';
}
export class AiRefusedError extends Error {
  override name = 'AiRefusedError';
}
export class AiResponseError extends Error {
  override name = 'AiResponseError';
}

export interface AiResult<T> {
  value: T;
  costUsd: number;
  via: AiBackend;
  /** What answered, stored with each review so a change of backend is visible. */
  model: string;
}

const CLI_NAMES: Record<Exclude<AiBackend, 'api'>, string> = { 'claude-code': 'claude', codex: 'codex', vibe: 'vibe' };
/** Apps launched from the Dock get a minimal PATH, so the usual install folders are searched too. */
const DEFAULT_EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(HOME, '.local', 'bin')];
let extraDirs = DEFAULT_EXTRA_DIRS;
/** Tests point this at a fixture so real installs on the machine do not leak in. */
export const setExtraCliDirs = (dirs: string[] | null): void => { extraDirs = dirs ?? DEFAULT_EXTRA_DIRS; };

function findCli(name: string): string | null {
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extraDirs];
  return dirs.map(dir => join(dir, name)).find(p => existsSync(p)) ?? null;
}

const hasAnthropicKey = (): boolean => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const isAvailable = (backend: AiBackend): boolean => (backend === 'api' ? hasAnthropicKey() : !!findCli(CLI_NAMES[backend]));

export interface AiOption { id: AiBackend; label: string; available: boolean }
export interface AiAvailability { via: AiBackend | null; label: string | null; detail: string; options: AiOption[] }

/** The chosen backend when it is installed, otherwise the first one found, Claude Code first so existing setups keep working. */
export function aiAvailability(): AiAvailability {
  const options = AI_BACKENDS.map(id => ({ id, label: AI_BACKEND_LABELS[id], available: isAvailable(id) }));
  const chosen = readAiBackend();
  const preferred = options.find(o => o.id === chosen && o.available) ?? options.find(o => o.available) ?? null;
  if (!preferred) return { via: null, label: null, detail: 'Install Claude Code, Codex or Mistral Vibe, or set ANTHROPIC_API_KEY, to use AI features.', options };
  const missing = chosen && chosen !== preferred.id ? ` ${AI_BACKEND_LABELS[chosen as AiBackend] ?? chosen} is not installed, so ${preferred.label} is used.` : '';
  return { via: preferred.id, label: preferred.label, detail: `AI review uses ${preferred.label}.${missing}`, options };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export type ProcessRunner = (command: string, args: string[], input: string, cwd: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const runProcess: ProcessRunner = (command, args, input, cwd, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new AiResponseError(`No answer within ${timeoutMs / 1000}s`)); }, timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  child.stdin.end(input);
});

/** Tests swap this to check the command lines without starting a real agent. */
let runner: ProcessRunner = runProcess;
export const setProcessRunner = (next: ProcessRunner | null): void => { runner = next ?? runProcess; };

const CliReply = z.object({ is_error: z.boolean().optional(), result: z.unknown().optional(), structured_output: z.unknown().optional(), total_cost_usd: z.number().optional() });

/** Claude Code rejects the draft 2020-12 $schema marker that Zod adds, so it is left out. */
function cliSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _marker, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * Codex structured output needs every property required and no extra ones. Optional fields become
 * "this type or null", and dropNulls turns those nulls back into missing fields before parsing.
 */
export function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) if (key !== '$schema') out[key] = strictSchema(value);
  if (out.type === 'object' && typeof out.properties === 'object' && out.properties !== null) {
    const props = out.properties as Record<string, unknown>;
    const required = new Set(Array.isArray(out.required) ? out.required as string[] : []);
    for (const key of Object.keys(props)) if (!required.has(key)) props[key] = { anyOf: [props[key], { type: 'null' }] };
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/** No Klosti schema has a nullable field, so any null came from an optional field left empty. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)]));
}

/** The first JSON object in a reply, tolerating code fences and text around it. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [text.trim(), fenced?.trim()]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try the next shape */ }
  }
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new AiResponseError('The answer had no JSON in it.');
}

const failure = (name: string, code: number | null, stdout: string, stderr: string): AiResponseError =>
  new AiResponseError((stderr || stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300) || `${name} exited with ${code}`);

/** Every CLI runs in an empty scratch folder, so no project instructions or files are in play. */
async function inScratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), 'klosti-'));
  try { return await work(scratch); } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Headless Claude Code with no settings, plugins, hooks, MCP servers or tools, so only the prompt is in play. */
const askViaClaudeCode = <T>(cli: string, prompt: string, schema: z.ZodType<T>): Promise<AiResult<T>> => inScratch(async scratch => {
  const args = ['-p', '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--model', AI_MODEL, '--output-format', 'json', '--json-schema', JSON.stringify(cliSchema(schema))];
  const { code, stdout, stderr } = await runner(cli, args, prompt, scratch, CALL_TIMEOUT_MS);
  if (code !== 0) throw failure('Claude Code', code, stdout, stderr);
  const reply = CliReply.parse(JSON.parse(stdout));
  if (reply.is_error || reply.structured_output === undefined) throw new AiResponseError(String(reply.result ?? 'No structured answer').slice(0, 300));
  return { value: schema.parse(reply.structured_output), costUsd: reply.total_cost_usd ?? 0, via: 'claude-code', model: AI_MODEL };
});

/**
 * codex exec in a read-only sandbox, without the user's config.toml (its MCP servers, model choice and
 * rules), saving nothing, with the final message forced into the schema and written to a file.
 */
const askViaCodex = <T>(cli: string, prompt: string, schema: z.ZodType<T>): Promise<AiResult<T>> => inScratch(async scratch => {
  const schemaFile = join(scratch, 'schema.json'), answerFile = join(scratch, 'answer.json');
  writeFileSync(schemaFile, JSON.stringify(strictSchema(z.toJSONSchema(schema))));
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', answerFile, '-'];
  const { code, stdout, stderr } = await runner(cli, args, prompt, scratch, CALL_TIMEOUT_MS);
  if (code !== 0) throw failure('Codex', code, stdout, stderr);
  if (!existsSync(answerFile)) throw new AiResponseError('Codex finished without an answer.');
  return { value: schema.parse(dropNulls(extractJson(readFileSync(answerFile, 'utf8')))), costUsd: 0, via: 'codex', model: 'Codex default model' };
});

const VibeMessage = z.object({ role: z.string(), content: z.unknown() });

/**
 * Vibe programmatic mode with every tool off and one turn. It cannot enforce a schema, so the prompt
 * asks for JSON matching it and the reply is validated, then retried like any malformed answer.
 */
const askViaVibe = <T>(cli: string, prompt: string, schema: z.ZodType<T>): Promise<AiResult<T>> => inScratch(async scratch => {
  const framed = `${prompt}\n\nAnswer with only one JSON object that matches this JSON Schema, with no text before or after it:\n${JSON.stringify(cliSchema(schema))}`;
  // -p with no text reads the prompt from stdin, which avoids argument size limits on long prompts.
  const args = ['-p', '--output', 'json', '--max-turns', VIBE_MAX_TURNS, '--enabled-tools', VIBE_NO_TOOLS, '--workdir', scratch];
  const { code, stdout, stderr } = await runner(cli, args, framed, scratch, CALL_TIMEOUT_MS);
  if (code !== 0) throw failure('Mistral Vibe', code, stdout, stderr);
  const messages = z.array(VibeMessage).parse(JSON.parse(stdout));
  const last = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  if (!last) throw new AiResponseError('Mistral Vibe finished without an answer.');
  return { value: schema.parse(dropNulls(extractJson(last.content as string))), costUsd: 0, via: 'vibe', model: 'Mistral Vibe active model' };
});

async function askViaApi<T>(prompt: string, schema: z.ZodType<T>): Promise<AiResult<T>> {
  const client = new Anthropic({ timeout: CALL_TIMEOUT_MS, maxRetries: 2 });
  const response = await client.beta.messages.parse({
    model: AI_MODEL,
    max_tokens: MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') throw new AiRefusedError('The model declined this request.');
  if (response.parsed_output == null) throw new AiResponseError('The answer did not match the expected format.');
  return { value: response.parsed_output as T, costUsd: 0, via: 'api', model: AI_MODEL };
}

const isRetryable = (error: unknown): boolean => {
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError) return true;
  return error instanceof AiResponseError || error instanceof SyntaxError || error instanceof z.ZodError;
};

function callOnce<T>(backend: AiBackend, prompt: string, schema: z.ZodType<T>): Promise<AiResult<T>> {
  if (backend === 'api') return askViaApi(prompt, schema);
  const cli = findCli(CLI_NAMES[backend]);
  if (!cli) throw new AiUnavailableError(`${AI_BACKEND_LABELS[backend]} is not installed.`);
  if (backend === 'codex') return askViaCodex(cli, prompt, schema);
  if (backend === 'vibe') return askViaVibe(cli, prompt, schema);
  return askViaClaudeCode(cli, prompt, schema);
}

/** One structured call through the backend chosen in Settings, or the first one installed. Retries transient failures with backoff. */
export async function askAi<T>(prompt: string, schema: z.ZodType<T>): Promise<AiResult<T>> {
  const { via, detail } = aiAvailability();
  if (!via) throw new AiUnavailableError(detail);
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await callOnce(via, prompt, schema);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) break;
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }
  if (lastError instanceof AiResponseError) throw new AiResponseError(`${AI_BACKEND_LABELS[via]}: ${lastError.message}`);
  throw lastError instanceof Error ? lastError : new AiResponseError(String(lastError));
}
