/** The published .dmg, for example a GitHub release. Until it is set, the site leads with the CLI and hides the Mac download. */
export const MAC_DOWNLOAD_URL: string | null = process.env.NEXT_PUBLIC_MAC_DOWNLOAD_URL || null;

export const DOWNLOAD_PAGE = "/download";

export const CLI_COMMAND = "npx klosti";

export const PLATFORM_NOTE = "For macOS 11 or later, on Macs with Apple silicon";

export const CLI_NOTE = "Runs locally on macOS, Linux and Windows. Requires Node 20 or later. Mac app coming soon.";
