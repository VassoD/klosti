/** Line diffs for the Changes view. Myers' algorithm, small enough to keep without a dependency. */

export interface Hunk {
  oldStart: number;
  newStart: number;
  /** Each line starts with ' ', '+' or '-'. */
  lines: string[];
}

export interface FileDiff {
  /** The file inside the skill folder, or the file name for a single-file item. */
  file: string;
  status: 'added' | 'changed' | 'removed';
  added: number;
  removed: number;
  hunks?: Hunk[];
  /** Why no lines are shown, such as a binary file or no earlier copy to compare with. */
  note?: string;
  /** Some lines were left out to keep the history small. */
  truncated?: boolean;
}

export const CONTEXT_LINES = 3;
/** Above this, Myers gets slow and the diff stops being readable anyway. */
const MAX_INPUT_LINES = 5000;
const MAX_OUTPUT_LINES = 300;
const MAX_LINE_CHARS = 400;

const splitLines = (text: string): string[] => (text === '' ? [] : text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n'));

type Op = ' ' | '+' | '-';

/** Past this many edits the diff is unreadable and the trace would use too much memory. */
const MAX_EDITS = 2000;

/** The shortest edit script from a to b, as one op per line, or null when there are too many edits. */
function editScript(a: string[], b: string[]): Op[] | null {
  const n = a.length, m = b.length, max = Math.min(n + m, MAX_EDITS), offset = max + 1;
  const v = new Array<number>(2 * max + 3).fill(0);
  // Only the diagonals -d..d matter in round d, so each snapshot keeps just that window.
  const trace: number[][] = [];
  let done = false;
  for (let d = 0; d <= max && !done; d += 1) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
  }
  if (!done) return null;
  const at = (d: number, k: number): number => trace[d]![k + d]!;
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const k = x - y;
    const prevK = k === -d || (k !== d && at(d, k - 1) < at(d, k + 1)) ? k + 1 : k - 1;
    const prevX = at(d, prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(' '); x -= 1; y -= 1; }
    ops.push(x === prevX ? '+' : '-');
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { ops.push(' '); x -= 1; y -= 1; }
  return ops.reverse();
}

/** Counting by line multiset keeps the totals honest without running Myers. */
function roughCounts(a: string[], b: string[]): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of b) { const c = counts.get(l) ?? 0; if (c) counts.set(l, c - 1); else added += 1; }
  return { added, removed: [...counts.values()].reduce((sum, c) => sum + c, 0) };
}

const clip = (line: string): string => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);

/** Added and removed line counts plus readable hunks with a few lines of context. */
export function lineDiff(before: string, after: string, file = ''): FileDiff {
  const a = splitLines(before), b = splitLines(after);
  const status: FileDiff['status'] = before === '' && after !== '' ? 'added' : after === '' && before !== '' ? 'removed' : 'changed';
  const ops = a.length > MAX_INPUT_LINES || b.length > MAX_INPUT_LINES ? null : editScript(a, b);
  if (!ops) return { file, status, ...roughCounts(a, b), note: 'Too long to show line by line.' };
  const added = ops.filter(o => o === '+').length, removed = ops.filter(o => o === '-').length;
  const rows: { op: Op; text: string; oldNo: number; newNo: number }[] = [];
  let i = 0, j = 0;
  for (const op of ops) {
    rows.push({ op, text: op === '+' ? b[j]! : a[i]!, oldNo: i + 1, newNo: j + 1 });
    if (op !== '+') i += 1;
    if (op !== '-') j += 1;
  }
  const hunks: Hunk[] = [];
  let shown = 0, truncated = false, r = 0;
  while (r < rows.length) {
    if (rows[r]!.op === ' ') { r += 1; continue; }
    const start = Math.max(0, r - CONTEXT_LINES);
    let end = r;
    // Merge changes closer than twice the context into one hunk.
    while (end < rows.length) {
      let next = end;
      while (next < rows.length && rows[next]!.op !== ' ') next += 1;
      let gap = next;
      while (gap < rows.length && rows[gap]!.op === ' ') gap += 1;
      if (gap < rows.length && gap - next <= CONTEXT_LINES * 2) { end = gap; continue; }
      end = Math.min(rows.length, next + CONTEXT_LINES);
      break;
    }
    const slice = rows.slice(start, end);
    if (shown + slice.length > MAX_OUTPUT_LINES) { truncated = true; break; }
    hunks.push({ oldStart: slice[0]!.oldNo, newStart: slice[0]!.newNo, lines: slice.map(row => `${row.op}${clip(row.text)}`) });
    shown += slice.length;
    r = end;
  }
  return { file, status, added, removed, hunks, ...(truncated ? { truncated } : {}) };
}

/** The first lines of a text, for an added or removed item. */
export const previewLines = (text: string, limit = 20): string[] => splitLines(text).slice(0, limit).map(clip);
