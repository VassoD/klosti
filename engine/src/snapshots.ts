import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/** Supporting files bigger than this are fingerprinted but not kept, so their changes show counts only. */
export const SNAPSHOT_MAX_BYTES = 64 * 1024;

/**
 * Earlier copies of skill supporting files, so a later change can show which lines moved. Stored once per
 * content (named by its hash) and gzipped. SKILL.md and rule files need none: the inventory keeps their text.
 */
export class Snapshots {
  constructor(readonly dir: string) {}

  private file(sha: string): string { return join(this.dir, `${sha}.gz`); }

  /** Pass the file's own hash when known, so the copy is found under the same name the scan recorded. */
  put(text: string, known?: string): string {
    const sha = known ?? createHash('sha256').update(text).digest('hex');
    if (existsSync(this.file(sha))) return sha;
    // Created on first use: Delete all data can remove the data folder while the app keeps running.
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(sha), gzipSync(text));
    return sha;
  }

  get(sha: string): string | null {
    try { return gunzipSync(readFileSync(this.file(sha))).toString('utf8'); } catch { return null; }
  }

  /** Drops every copy the latest scan no longer points to. */
  keep(shas: Set<string>): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (name.endsWith('.gz') && !shas.has(name.slice(0, -3))) rmSync(join(this.dir, name), { force: true });
    }
  }
}
