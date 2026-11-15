import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const TEMPLATE = process.env.KLOSTI_TEMPLATE ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'template.html');
const EARLY_RETURN = 'if(D.onboarding){welcome(D.onboarding);return;}';
/** Everything "Scan and continue" and the folder tree run on the welcome screen. */
const WELCOME_FUNCTIONS = ['welcome', 'uncheckedProjects', 'refreshFolderBoxes', 'syncFolderTree', 'chooseFolder', 'folderProjects', 'startsOff', 'projectOn'];

/** A top-level function's source, from its declaration to the closing brace at the start of a line. */
function functionSource(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the template should declare function ${name}`);
  const end = script.indexOf('\n}', start);
  const sameLine = script.slice(start, script.indexOf('\n', start));
  return end < 0 || sameLine.endsWith('}') ? sameLine : script.slice(start, end + 2);
}

/** Names a top-level const or let declares after the welcome screen's early return. They are never initialized on first run. */
function namesDeclaredAfterReturn(script: string): string[] {
  const after = script.slice(script.indexOf(EARLY_RETURN) + EARLY_RETURN.length);
  return [...after.matchAll(/^(?:const|let) ([A-Za-z_$][\w$]*)=/gm)].map(m => m[1]!);
}

/** Blanks out string and template-literal text, keeping the code inside ${...}, so words in HTML or messages are not read as variables. */
function codeOnly(raw: string): string {
  // A character-class regex such as /[&<>"']/g holds quote characters that would read as the start of a string.
  const source = raw.replace(/\/\[[^\]\n]*\]\/[gimsuy]*/g, m => ' '.repeat(m.length));
  let out = '';
  const stack: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!, quote = stack.at(-1);
    const inString = quote === '"' || quote === "'" || quote === '`';
    if (inString) {
      if (c === '\\') { out += '  '; i++; continue; }
      if (c === quote) { stack.pop(); out += c; continue; }
      if (quote === '`' && c === '$' && source[i + 1] === '{') { stack.push('}'); out += '${'; i++; continue; }
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') stack.push(c);
    else if (c === '{' && (quote === '}' || quote === '{')) stack.push('{');
    else if (c === '}' && (quote === '}' || quote === '{')) stack.pop();
    out += c;
  }
  return out;
}

function lateNamesUsedBy(script: string, name: string): string[] {
  const source = codeOnly(functionSource(script, name));
  const identifiers = (list: string): string[] => list.split(',').map(p => p.trim().replace(/=.*$/, '')).filter(p => /^[A-Za-z_$][\w$]*$/.test(p));
  const local = new Set([
    ...[...source.matchAll(/(?:const|let) ([A-Za-z_$][\w$]*)=/g)].map(m => m[1]!),
    ...[...source.matchAll(/([A-Za-z_$][\w$]*)=>/g)].map(m => m[1]!),
    ...[...source.matchAll(/\(([^()]*)\)=>/g)].flatMap(m => identifiers(m[1]!)),
    ...[...source.matchAll(/function [\w$]*\(([^)]*)\)/g)].flatMap(m => identifiers(m[1]!)),
  ]);
  // A dash before the name means a CSS or HTML word such as aria-live, not a variable.
  return namesDeclaredAfterReturn(script).filter(late => !local.has(late) && new RegExp(`(?<![\\w$.-])${late.replace('$', '\\$')}(?![\\w$-])`).test(source));
}

describe('welcome screen', () => {
  const script = readFileSync(TEMPLATE, 'utf8');

  it('should return early for onboarding, which is what makes later consts unsafe', () => {
    assert.ok(script.includes(EARLY_RETURN));
  });

  for (const name of WELCOME_FUNCTIONS) {
    it(`should not use a const declared after the early return in ${name}, so Scan and continue works on first run`, () => {
      assert.deepEqual(lateNamesUsedBy(script, name), [], `${name} would throw "Cannot access before initialization" on first run`);
    });
  }
});
