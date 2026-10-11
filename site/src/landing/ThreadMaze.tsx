"use client";

import { useThreadMaze } from "@/landing/useThreadMaze";

const FILES_IN_THE_MAZE = ["CLAUDE.md", "AGENTS.md", ".cursor/rules", "GEMINI.md", "settings.json", ".mcp.json", "SKILL.md"];

export function ThreadMaze(): React.JSX.Element {
  const canvasRef = useThreadMaze();

  return (
    <div className="wrap maze">
      <canvas ref={canvasRef} aria-hidden="true" />
      <p className="maze-caption">{FILES_IN_THE_MAZE.join(" · ")}</p>
    </div>
  );
}
