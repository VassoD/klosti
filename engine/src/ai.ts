import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import { HOME } from './config.ts';

/** Override with KLOSTI_MODEL, for example claude-sonnet-5-5 for lower cost. */
export const AI_MODEL = process.env.KLOSTI_MODEL ?? process.env.AGENT_RULEBOOK_MODEL ?? 'claude-opus-5-5';
const MAX_TOKENS = 16000;
const CALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const CLAUDE_CANDIDATES = [join(HOME, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];

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
  via: 'claude-code' | 'api';
}

function findClaudeCli(): string | null {
  const onPath = (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, 'claude')).find(p => existsSync(p));
  return onPath ?? CLAUDE_CANDIDATES.find(p => existsSync(p)) ?? null;
}

export function aiAvailability(): { via: 'claude-code' | 'api' | null; detail: string } {
  if (findClaudeCli()) return { via: 'claude-code', detail: 'Uses your Claude Code account.' };
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return { via: 'api', detail: 'Uses your Anthropic API key.' };
  return { via: null, detail: 'Install Claude Code or set ANTHROPIC_API_KEY to use AI features.' };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function runProcess(command: string, args: string[], input: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new AiResponseError(`Claude Code did not answer within ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

const CliReply = z.object({ is_error: z.boolean().optional(), result: z.unknown().optional(), structured_output: z.unknown().optional(), total_cost_usd: z.number().optional() });

/** Headless Claude Code with no settings, plugins, hooks, MCP servers or tools, so only the prompt is in play. */
async function askViaClaudeCode<T>(cli: string, prompt: string, schema: z.ZodType<T>): Promise<AiResult<T>> {
  const scratch = mkdtempSync(join(tmpdir(), 'klosti-'));
  try {
    const args = ['-p', '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--model', AI_MODEL, '--output-format', 'json', '--json-schema', JSON.stringify(z.toJSONSchema(schema))];
    const { code, stdout, stderr } = await runProcess(cli, args, prompt, scratch, CALL_TIMEOUT_MS);
    if (code !== 0) throw new AiResponseError((stderr || stdout).trim().slice(0, 300) || `Claude Code exited with ${code}`);
    const reply = CliReply.parse(JSON.parse(stdout));
    if (reply.is_error || reply.structured_output === undefined) throw new AiResponseError(String(reply.result ?? 'No structured answer').slice(0, 300));
    return { value: schema.parse(reply.structured_output), costUsd: reply.total_cost_usd ?? 0, via: 'claude-code' };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

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
  if (response.stop_reason === 'refusal') throw new AiRefusedError('Claude declined this request.');
  if (response.parsed_output == null) throw new AiResponseError('The answer did not match the expected format.');
  return { value: response.parsed_output as T, costUsd: 0, via: 'api' };
}

const isRetryable = (error: unknown): boolean => {
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError) return true;
  return error instanceof AiResponseError || error instanceof SyntaxError || error instanceof z.ZodError;
};

/** One structured call, through Claude Code when installed, otherwise the API. Retries transient failures with backoff. */
export async function askClaude<T>(prompt: string, schema: z.ZodType<T>): Promise<AiResult<T>> {
  const cli = findClaudeCli();
  if (!cli && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new AiUnavailableError(aiAvailability().detail);
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return cli ? await askViaClaudeCode(cli, prompt, schema) : await askViaApi(prompt, schema);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) break;
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new AiResponseError(String(lastError));
}
