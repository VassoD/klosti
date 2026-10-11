import { WALL_E, WALL_N, WALL_S, WALL_W, type Maze } from "@/landing/maze";

export interface MazeColors {
  wall: string;
  thread: string;
  background: string;
}

/** Horizontal room outside the maze for the ball of thread on the left and the loose end on the right. */
export const MAZE_SIDE_ROOM_PX = 26;
const BALL_RADIUS_PX = 9;
const BALL_CENTER_X = -MAZE_SIDE_ROOM_PX / 2;

type Point = [number, number];

function threadPoints(maze: Maze, cell: number): Point[] {
  const { cols, path, entryRow, exitRow } = maze;
  const points: Point[] = [[BALL_CENTER_X, (entryRow + 0.5) * cell]];
  for (const index of path) points.push([((index % cols) + 0.5) * cell, (Math.floor(index / cols) + 0.5) * cell]);
  points.push([cols * cell + MAZE_SIDE_ROOM_PX * 0.6, (exitRow + 0.5) * cell]);
  return points;
}

function pathLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

function drawWalls(ctx: CanvasRenderingContext2D, maze: Maze, cell: number): void {
  const { cols, rows, walls } = maze;
  ctx.beginPath();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const bits = walls[y * cols + x];
      const px = x * cell;
      const py = y * cell;
      if (bits & WALL_N) { ctx.moveTo(px, py); ctx.lineTo(px + cell, py); }
      if (bits & WALL_W) { ctx.moveTo(px, py); ctx.lineTo(px, py + cell); }
      if (x === cols - 1 && bits & WALL_E) { ctx.moveTo(px + cell, py); ctx.lineTo(px + cell, py + cell); }
      if (y === rows - 1 && bits & WALL_S) { ctx.moveTo(px, py + cell); ctx.lineTo(px + cell, py + cell); }
    }
  }
  ctx.stroke();
}

/** Draws the maze, then the thread from the entrance, unwound as far as `progress` (0 to 1). */
export function drawMaze(ctx: CanvasRenderingContext2D, maze: Maze, cell: number, progress: number, colors: MazeColors): void {
  ctx.clearRect(-MAZE_SIDE_ROOM_PX, -4, maze.cols * cell + MAZE_SIDE_ROOM_PX * 2, maze.rows * cell + 8);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.strokeStyle = colors.wall;
  ctx.lineWidth = 1.6;
  drawWalls(ctx, maze, cell);

  const points = threadPoints(maze, cell);
  const total = pathLength(points);
  ctx.save();
  ctx.strokeStyle = colors.thread;
  ctx.lineWidth = Math.max(2.4, cell * 0.12);
  ctx.setLineDash([total * progress, total + 1]);
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i][0] + points[i + 1][0]) / 2;
    const midY = (points[i][1] + points[i + 1][1]) / 2;
    ctx.quadraticCurveTo(points[i][0], points[i][1], midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
  ctx.restore();

  drawBall(ctx, BALL_CENTER_X, (maze.entryRow + 0.5) * cell, colors);
}

/** A ball of yarn: a filled circle with a few wound strands drawn across it. */
function drawBall(ctx: CanvasRenderingContext2D, x: number, y: number, colors: MazeColors): void {
  ctx.save();
  ctx.fillStyle = colors.thread;
  ctx.beginPath();
  ctx.arc(x, y, BALL_RADIUS_PX, 0, Math.PI * 2);
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = colors.background;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.2;
  for (const [tilt, offset] of [[-0.5, -3.5], [-0.5, 0.5], [-0.5, 4.5], [0.9, -2]] as const) {
    ctx.beginPath();
    ctx.ellipse(x + offset * Math.cos(tilt + Math.PI / 2), y + offset * Math.sin(tilt + Math.PI / 2), BALL_RADIUS_PX * 1.3, BALL_RADIUS_PX * 0.45, tilt, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
