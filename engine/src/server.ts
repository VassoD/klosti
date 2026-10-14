import { randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { ActionRefused, Actions, openInBrowser, pickFolder, rescan } from './actions.ts';
import { AiRefusedError, AiUnavailableError } from './ai.ts';
import { HOME, onboardingChoices, type ResolvedConfig } from './config.ts';
import { payload, renderPage } from './page.ts';
import { planReview, runReview } from './review.ts';
import type { Store } from './store.ts';

const MAX_BODY_BYTES = 10_000;
const WATCH_DEBOUNCE_MS = 4000;
const PERIODIC_RESCAN_MS = 3 * 60 * 60 * 1000;
/** Folders where installs land. Project skills are caught by the periodic rescan. */
const WATCHED = ['.claude/skills', '.claude/plugins', '.codex/skills', '.codex/config.toml', '.agents/skills', '.gemini/skills', '.vibe/skills', '.vibe/agents', '.vibe/config.toml'];

const Body = z.object({
  finding: z.string().optional(), quote: z.number().optional(), dryRun: z.boolean().optional(), expect: z.string().optional(),
  proposal: z.string().optional(), title: z.string().optional(), resolved: z.boolean().optional(),
  backup: z.string().optional(), backups: z.array(z.string()).optional(), open: z.string().nullable().optional(),
  id: z.string().optional(), path: z.string().optional(), force: z.boolean().optional(), ignore: z.boolean().optional(),
  roots: z.array(z.string()).optional(), agents: z.array(z.string()).optional(), ignored: z.array(z.string()).optional(),
  backend: z.string().optional(),
});

export interface ServerOptions { port: number; watch: boolean; onChange?: (summary: ChangeSummary) => void }
export interface ChangeSummary { added: string[]; changed: string[]; removed: string[] }

export class KlostiServer {
  private readonly token = randomBytes(24).toString('base64url');
  private readonly actions: Actions;
  private readonly watchers: FSWatcher[] = [];
  private server: Server | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private periodic: NodeJS.Timeout | null = null;
  /** Bumped on every rescan so open pages know to reload. */
  private version = Date.now();
  private busy: Promise<unknown> = Promise.resolve();
  private reviewing = false;
  /** The real port, which differs from options.port when 0 asked the OS for a free one. */
  private port = 0;

  constructor(private readonly store: Store, private readonly config: ResolvedConfig, private readonly options: ServerOptions) {
    this.actions = new Actions(store, config);
  }

  /** One change at a time: each one rescans and rewrites the cache. */
  private serialize<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.busy.then(work, work);
    this.busy = next.catch(() => undefined);
    return next;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.options.port, '127.0.0.1', resolve); });
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : this.options.port;
    if (this.options.watch) this.startWatching();
    return `http://127.0.0.1:${this.port}/`;
  }

  async stop(): Promise<void> {
    this.watchers.forEach(w => w.close());
    if (this.periodic) clearInterval(this.periodic);
    await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private startWatching(): void {
    for (const rel of WATCHED) {
      try { this.watchers.push(watch(join(HOME, rel), () => this.scheduleRescan())); } catch { /* folder does not exist */ }
    }
    this.periodic = setInterval(() => this.scheduleRescan(), PERIODIC_RESCAN_MS);
  }

  private scheduleRescan(): void {
    if (!this.config.onboarded) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      void this.serialize(() => {
        const before = this.store.inventory().history?.length ?? 0;
        rescan(this.store, this.config);
        this.version = Date.now();
        const history = this.store.inventory().history ?? [];
        const latest = history.length > before ? history.at(-1) : undefined;
        if (latest && this.options.onChange) this.options.onChange({ added: latest.added.map(c => c.name), changed: latest.changed.map(c => c.name), removed: latest.removed.map(c => c.name) });
      });
    }, WATCH_DEBOUNCE_MS);
  }

  private allowedHost(req: IncomingMessage): boolean {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`].includes(req.headers.host ?? '');
  }

  private send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  }

  private async readBody(req: IncomingMessage): Promise<z.infer<typeof Body>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new ActionRefused('Request too large.');
      chunks.push(chunk as Buffer);
    }
    return Body.parse(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowedHost(req)) return this.send(res, 403, { error: 'Forbidden host' });
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      if (!this.config.onboarded) return this.send(res, 200, renderPage({ onboarding: onboardingChoices(this.config) }, { token: this.token }), 'text/html; charset=utf-8');
      return this.send(res, 200, renderPage({ ...payload(this.store, this.actions.current(), this.config), version: this.version }, { token: this.token }), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && path === '/api/version') return this.send(res, 200, { version: this.version });
    if (req.method !== 'POST' || req.headers['x-klosti-token'] !== this.token) return this.send(res, 403, { error: 'This page is out of date. Reload it.' });
    try {
      const body = await this.readBody(req);
      const reply = await this.route(path ?? '', body);
      if (!reply) return this.send(res, 404, { error: 'Not found' });
      this.send(res, 200, { ok: true, ...reply });
    } catch (error) {
      if (error instanceof ActionRefused || error instanceof AiUnavailableError || error instanceof AiRefusedError) return this.send(res, 400, { error: error.message });
      if (error instanceof z.ZodError || error instanceof SyntaxError) return this.send(res, 400, { error: 'Malformed request.' });
      console.error(JSON.stringify({ level: 'error', at: new Date().toISOString(), path, error: error instanceof Error ? error.stack : String(error) }));
      this.send(res, 500, { error: 'That did not work. See the log for details.' });
    }
  }

  private async route(path: string, body: z.infer<typeof Body>): Promise<Record<string, unknown> | null> {
    const a = this.actions;
    const changed = <T>(reply: T): T => { this.version = Date.now(); return reply; };
    switch (path) {
      case '/api/propose-fix': return { ...(await a.proposeFix(body.finding ?? '')) };
      case '/api/rule-line':
        if (body.dryRun) return { ...a.deleteRuleLine(body.finding ?? '', body.quote ?? -1, { dryRun: true }) };
        return this.serialize(() => changed({ ...a.deleteRuleLine(body.finding ?? '', body.quote ?? -1, { expect: body.expect }) }));
      case '/api/apply-fix': return this.serialize(() => changed({ ...a.applyFix(body.proposal ?? '') }));
      case '/api/resolve': return this.serialize(() => changed({ ...a.resolve(body.finding, body.title, body.resolved ?? true) }));
      case '/api/undo': return this.serialize(() => changed({ ...a.undo(body.backups ?? (body.backup ? [body.backup] : []), body.open ?? undefined) }));
      case '/api/trash': return this.serialize(() => changed({ ...a.trash(body.id ?? '', body.path ?? '') }));
      case '/api/open-url': openInBrowser(body.path ?? ''); return { message: '' };
      case '/api/pick-folder': { const path = await pickFolder('Choose a folder where you keep code'); return path ? { path } : { cancelled: true }; }
      case '/api/delete-data':
        if (this.reviewing) throw new ActionRefused('Wait for the AI review to finish first.');
        return this.serialize(() => changed({ ...a.deleteAllData() }));
      case '/api/onboard': return this.serialize(() => changed({ ...a.onboard(body.roots ?? [], body.agents ?? [], body.ignored ?? []) }));
      case '/api/settings': return this.serialize(() => changed({ ...a.saveSettings(body.roots ?? [], body.agents ?? [], body.ignored) }));
      case '/api/ai-backend': return this.serialize(() => changed({ ...a.setAiBackend(body.backend ?? '') }));
      case '/api/ignore-folder': return this.serialize(() => changed({ ...a.ignoreFolder(body.path ?? '', body.ignore ?? true) }));
      case '/api/remove-link': return this.serialize(() => changed({ ...a.removeLink(body.finding ?? '', body.path ?? '') }));
      case '/api/share-skill': return this.serialize(() => changed({ ...a.shareSkill(body.id ?? '', body.agents ?? []) }));
      case '/api/disable-plugin': return this.serialize(() => changed({ ...a.disablePlugin(body.id ?? '') }));
      case '/api/rescan': return this.serialize(() => { rescan(this.store, this.config); return changed({ message: 'Scanned again.' }); });
      case '/api/review': {
        // Not queued with file changes: a review takes minutes and only writes its own cache, in synchronous steps.
        if (this.reviewing) throw new ActionRefused('A review is already running.');
        const plan = planReview(a.current(), this.store, body.force ?? false, this.config.agents);
        if (!plan.jobs.length) return { message: 'Everything is already reviewed.' };
        this.reviewing = true;
        try {
          const result = await runReview(plan, this.store);
          const cost = result.costUsd ? ` About $${result.costUsd.toFixed(2)} at list price.` : '';
          return changed({ message: `Reviewed ${result.reviewed} of ${plan.jobs.length} places.${result.failed.length ? ` ${result.failed.length} failed.` : ''}${cost}` });
        } finally {
          this.reviewing = false;
        }
      }
      default: return null;
    }
  }
}
