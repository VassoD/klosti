import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMaze, createRandom, WALL_E, WALL_N, WALL_S, WALL_W } from "./maze.ts";

const NEIGHBOUR_WALLS: Record<number, number> = { [1]: WALL_E, [-1]: WALL_W };

describe("buildMaze", () => {
  it("should draw the same maze for the same size and seed", () => {
    assert.deepEqual(buildMaze(20, 9, 7), buildMaze(20, 9, 7));
  });

  it("should open the entrance on the left edge and the exit on the right edge", () => {
    const maze = buildMaze(20, 9, 7);
    assert.equal(maze.walls[maze.entryRow * maze.cols] & WALL_W, 0, "entrance wall is still closed");
    assert.equal(maze.walls[maze.exitRow * maze.cols + maze.cols - 1] & WALL_E, 0, "exit wall is still closed");
  });

  it("should return a path from entrance to exit through open walls only", () => {
    const maze = buildMaze(32, 9, 39);
    const { cols, path, walls } = maze;
    assert.equal(path[0], maze.entryRow * cols);
    assert.equal(path[path.length - 1], maze.exitRow * cols + cols - 1);
    for (let i = 1; i < path.length; i++) {
      const step = path[i] - path[i - 1];
      const wall = NEIGHBOUR_WALLS[step] ?? (step === cols ? WALL_S : WALL_N);
      assert.equal(walls[path[i - 1]] & wall, 0, `path crosses a wall at step ${i}`);
    }
  });

  it("should carve every cell, so the maze has no sealed rooms", () => {
    const maze = buildMaze(12, 6, 3);
    assert.ok(maze.walls.every((cell) => cell !== (WALL_N | WALL_E | WALL_S | WALL_W)));
  });

  it("should reject grids smaller than 2x2", () => {
    assert.throws(() => buildMaze(1, 9, 7), RangeError);
  });
});

describe("createRandom", () => {
  it("should return numbers between 0 and 1", () => {
    const random = createRandom(42);
    for (let i = 0; i < 1000; i++) {
      const value = random();
      assert.ok(value >= 0 && value < 1, `got ${value}`);
    }
  });
});
