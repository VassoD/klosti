// Compiles the engine into one standalone binary that Tauri ships as a sidecar.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/host: (\S+)/)?.[1];
if (!triple) throw new Error('Could not read the Rust target triple. Is Rust installed?');
const out = join(app, 'src-tauri', 'binaries', `klosti-engine-${triple}${process.platform === 'win32' ? '.exe' : ''}`);
mkdirSync(dirname(out), { recursive: true });
execFileSync('bun', ['build', '--compile', '--minify', join(app, '..', 'engine', 'src', 'cli.ts'), '--outfile', out], { stdio: 'inherit' });
console.log(`Engine sidecar: ${out}`);
