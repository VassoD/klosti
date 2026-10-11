import Link from "next/link";

import { DownloadIcon } from "@/landing/DownloadIcon";
import { DOWNLOAD_PAGE } from "@/landing/links";

export function DownloadButton(): React.JSX.Element {
  return (
    <Link className="btn" href={DOWNLOAD_PAGE}>
      <DownloadIcon />
      Download for Mac
    </Link>
  );
}
