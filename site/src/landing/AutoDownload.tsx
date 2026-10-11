"use client";

import { useAutoDownload } from "@/landing/useAutoDownload";

interface AutoDownloadProps {
  url: string;
}

export function AutoDownload({ url }: AutoDownloadProps): React.JSX.Element {
  useAutoDownload(url);
  return (
    <p className="dl-manual">
      Your download will begin automatically. If it didn&apos;t start,{" "}
      <a href={url} download>
        download Klosti manually
      </a>
      .
    </p>
  );
}
