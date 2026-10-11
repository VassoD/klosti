export const WALL_N = 1;
export const WALL_E = 2;
export const WALL_S = 4;
export const WALL_W = 8;
const ALL_WALLS = WALL_N | WALL_E | WALL_S | WALL_W;

interface Move {
  wall: number;
  dx: number;
  dy: number;
  opposite: number;
}

const MOVES: readonly Move[] = [
  { wall: WALL_N, dx: 0, dy: -1, opposite: WALL_S },
  { wall: WALL_E, dx: 1, dy: 0, opposite: WALL_W },
  { wall: WALL_S, dx: 0, dy: 1, opposite: WALL_N },
  { wall: WALL_W, dx: -1, dy: 0, opposite: WALL_E },
];

export interface Maze {
  cols: number;
  rows: number;
  /** One bitmask of WALL_* flags per cell, row by row. */
  walls: number[];
  entryRow: number;
  exitRow: number;
  /** Cell indexes from the entrance on the left edge to the exit on the right edge. */
  path: number[];
}

/** Deterministic PRNG (mulberry32), so the same width always draws the same maze. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isInside(x: number, y: number, cols: number, rows: number): boolean {
  return x >= 0 && y >= 0 && x < cols && y < rows;
}

/** A perfect maze (one route between any two cells), carved with a depth-first backtracker. */
export function buildMaze(cols: number, rows: number, seed: number): Maze {
  if (cols < 2 || rows < 2) throw new RangeError(`A maze needs at least 2x2 cells, got ${cols}x${rows}`);

  const random = createRandom(seed);
  const walls = new Array<number>(cols * rows).fill(ALL_WALLS);
  const visited = new Array<boolean>(cols * rows).fill(false);
  const stack: Array<[number, number]> = [[0, 0]];
  visited[0] = true;

  while (stack.length > 0) {
    const [x, y] = stack[stack.length - 1];
    const options = MOVES.filter(({ dx, dy }) => {
      const nx = x + dx;
      const ny = y + dy;
      return isInside(nx, ny, cols, rows) && !visited[ny * cols + nx];
    });
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const move = options[Math.floor(random() * options.length)];
    const nx = x + move.dx;
    const ny = y + move.dy;
    walls[y * cols + x] &= ~move.wall;
    walls[ny * cols + nx] &= ~move.opposite;
    visited[ny * cols + nx] = true;
    stack.push([nx, ny]);
  }

  const entryRow = Math.floor(rows * 0.7);
  const exitRow = Math.floor(rows * 0.3);
  walls[entryRow * cols] &= ~WALL_W;
  walls[exitRow * cols + cols - 1] &= ~WALL_E;

  return { cols, rows, walls, entryRow, exitRow, path: solveMaze(cols, rows, walls, entryRow, exitRow) };
}

function solveMaze(cols: number, rows: number, walls: number[], entryRow: number, exitRow: number): number[] {
  const start = entryRow * cols;
  const goal = exitRow * cols + cols - 1;
  const previous = new Map<number, number>([[start, -1]]);
  const queue = [start];

  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    if (cell === goal) break;
    const x = cell % cols;
    const y = Math.floor(cell / cols);
    for (const { wall, dx, dy } of MOVES) {
      const nx = x + dx;
      const ny = y + dy;
      if (walls[cell] & wall || !isInside(nx, ny, cols, rows)) continue;
      const next = ny * cols + nx;
      if (!previous.has(next)) {
        previous.set(next, cell);
        queue.push(next);
      }
    }
  }

  const path: number[] = [];
  for (let cell = goal; cell !== -1; cell = previous.get(cell) ?? -1) path.unshift(cell);
  return path;
}
