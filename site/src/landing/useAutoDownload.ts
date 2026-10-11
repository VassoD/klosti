"use client";

import { useEffect, useRef } from "react";

const START_DELAY_MS = 600;

/** Starts a file download once after the page renders, the way "Thanks for downloading" pages do. */
export function useAutoDownload(url: string): void {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const timer = setTimeout(() => {
      const link = document.createElement("a");
      link.href = url;
      link.download = "";
      document.body.append(link);
      link.click();
      link.remove();
    }, START_DELAY_MS);
    return () => clearTimeout(timer);
  }, [url]);
}
