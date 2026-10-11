"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const RESET_AFTER_MS = 1800;

export type CopyState = "idle" | "copied" | "failed";

/** Copies text, and reports "failed" when the browser refuses so the caller can ask for a manual copy. */
export function useCopyToClipboard(): [CopyState, (text: string) => Promise<void>] {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), RESET_AFTER_MS);
  }, []);

  return [state, copy];
}
