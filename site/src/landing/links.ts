/** The .dmg the download page starts. Defaults to the copy scripts/copy-dmg.mjs puts in public/. */
export const MAC_DOWNLOAD_URL: string = process.env.NEXT_PUBLIC_MAC_DOWNLOAD_URL ?? "/downloads/Klosti.dmg";

export const DOWNLOAD_PAGE = "/download";

export const CLI_COMMAND = "npx klosti";

export const PLATFORM_NOTE = "For macOS 11 or later, on Macs with Apple silicon";
