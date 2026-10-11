"use client";

import { useEffect, useRef } from "react";

import { drawMaze, MAZE_SIDE_ROOM_PX, type MazeColors } from "@/landing/draw-maze";
import { buildMaze, type Maze } from "@/landing/maze";

const SEED = 7;
const ROWS = 9;
const MIN_CELL_PX = 26;
const MIN_COLS = 10;
const THREAD_MS = 2600;
const RESIZE_DEBOUNCE_MS = 120;
const EDGE_PAD_PX = 2;

function readColors(): MazeColors {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string): string => styles.getPropertyValue(name).trim();
  return { wall: read("--line-2"), thread: read("--clay"), background: read("--paper") };
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/** Sizes a maze to the canvas width, draws it in the page's theme colors, and unwinds the thread once on load. */
export function useThreadMaze(): React.RefObject<HTMLCanvasElement | null> {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const darkScheme = matchMedia("(prefers-color-scheme: dark)");
    let maze: Maze | null = null;
    let cell = MIN_CELL_PX;
    let progress = reduceMotion.matches ? 1 : 0;
    let frame = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    const draw = (): void => {
      if (maze) drawMaze(ctx, maze, cell, progress, readColors());
    };

    const layout = (): void => {
      const width = canvas.clientWidth;
      const mazeWidth = width - MAZE_SIDE_ROOM_PX * 2;
      const cols = Math.max(MIN_COLS, Math.floor(mazeWidth / MIN_CELL_PX));
      if (maze?.cols !== cols) maze = buildMaze(cols, ROWS, SEED + cols);
      cell = mazeWidth / cols;
      const height = ROWS * cell + EDGE_PAD_PX * 2;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.height = `${height}px`;
      ctx.setTransform(ratio, 0, 0, ratio, MAZE_SIDE_ROOM_PX * ratio, EDGE_PAD_PX * ratio);
      draw();
    };

    const play = (): void => {
      cancelAnimationFrame(frame);
      if (reduceMotion.matches) {
        progress = 1;
        draw();
        return;
      }
      const startedAt = performance.now();
      const tick = (now: number): void => {
        const t = Math.min(1, (now - startedAt) / THREAD_MS);
        progress = easeOutCubic(t);
        draw();
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };

    const onResize = (): void => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layout, RESIZE_DEBOUNCE_MS);
    };

    window.addEventListener("resize", onResize);
    darkScheme.addEventListener("change", draw);
    layout();
    play();

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      darkScheme.removeEventListener("change", draw);
    };
  }, []);

  return canvasRef;
}
