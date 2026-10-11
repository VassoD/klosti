// Copies brand/tokens.css into the app template and the site. `--check` fails instead of writing
// when either copy is out of date, so builds catch a token edited in only one place.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = readFileSync(join(ROOT, 'brand/tokens.css'), 'utf8').trim();
const START = '/* brand-tokens:start */';
const END = '/* brand-tokens:end */';
const isCheck = process.argv.includes('--check');

const targets = [
  {
    path: 'src/template.html',
    render: (current) => {
      const from = current.indexOf(START);
      const to = current.indexOf(END);
      if (from === -1 || to === -1) throw new Error(`src/template.html is missing the ${START} and ${END} markers`);
      return `${current.slice(0, from + START.length)}\n${TOKENS}\n${current.slice(to)}`;
    },
  },
  {
    path: 'site/src/app/brand-tokens.css',
    render: () => `/* Generated from brand/tokens.css by brand/sync.mjs. Do not edit. */\n${TOKENS}\n`,
  },
];

const stale = [];
for (const { path, render } of targets) {
  const file = join(ROOT, path);
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    current = '';
  }
  const next = render(current);
  if (next === current) continue;
  if (isCheck) stale.push(path);
  else {
    writeFileSync(file, next);
    console.log(`Updated ${path}`);
  }
}

if (stale.length) {
  console.error(`Brand tokens are out of date in ${stale.join(', ')}. Run: node brand/sync.mjs`);
  process.exit(1);
}
