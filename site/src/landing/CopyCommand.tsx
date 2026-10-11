"use client";

import { useRef } from "react";

import { useCopyToClipboard } from "@/landing/useCopyToClipboard";

const BUTTON_LABELS = { idle: "Copy", copied: "Copied", failed: "Press ⌘C" } as const;

interface CopyCommandProps {
  command: string;
}

export function CopyCommand({ command }: CopyCommandProps): React.JSX.Element {
  const [state, copy] = useCopyToClipboard();
  const textRef = useRef<HTMLSpanElement>(null);

  async function handleClick(): Promise<void> {
    await copy(command);
    if (textRef.current) {
      const range = document.createRange();
      range.selectNodeContents(textRef.current);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
  }

  return (
    <div className="cmd">
      <span ref={textRef}>{command}</span>
      <button type="button" onClick={handleClick} aria-live="polite">
        {BUTTON_LABELS[state]}
      </button>
    </div>
  );
}
