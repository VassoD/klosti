import type { Metadata } from "next";

import { AutoDownload } from "@/landing/AutoDownload";
import { InstallSteps } from "@/landing/InstallSteps";
import { MAC_DOWNLOAD_URL } from "@/landing/links";
import { SiteFooter } from "@/landing/SiteFooter";
import { SiteHeader } from "@/landing/SiteHeader";

export const metadata: Metadata = {
  title: "Download Klosti",
  description: "Download Klosti for Mac and install it in three steps.",
};

export default function DownloadPage(): React.JSX.Element {
  return (
    <>
      <SiteHeader />
      <main className="wrap download">
        <h1>Thanks for downloading! Just a few steps left.</h1>
        <AutoDownload url={MAC_DOWNLOAD_URL} />
        <InstallSteps />
        <SiteFooter />
      </main>
    </>
  );
}
