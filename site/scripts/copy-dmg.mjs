// Copies the newest Klosti .dmg from the desktop app's build output into public/downloads,
// so the site serves it at /downloads/Klosti.dmg. Skipped when NEXT_PUBLIC_MAC_DOWNLOAD_URL
// points somewhere else (for example a GitHub release).
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DMG_BUILD_DIR = join(SITE_DIR, "../app/src-tauri/target/release/bundle/dmg");
const TARGET = join(SITE_DIR, "public/downloads/Klosti.dmg");
const isStrict = process.argv.includes("--strict");

if (process.env.NEXT_PUBLIC_MAC_DOWNLOAD_URL) {
  console.log(`Using the download at ${process.env.NEXT_PUBLIC_MAC_DOWNLOAD_URL}`);
  process.exit(0);
}

const builds = existsSync(DMG_BUILD_DIR)
  ? readdirSync(DMG_BUILD_DIR)
      .filter((name) => name.endsWith(".dmg"))
      .map((name) => join(DMG_BUILD_DIR, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  : [];

if (builds.length === 0) {
  const message = "No Klosti .dmg found. Run `npm run build` in app/, or set NEXT_PUBLIC_MAC_DOWNLOAD_URL.";
  if (isStrict) {
    console.error(message);
    process.exit(1);
  }
  console.warn(`${message} The download button will 404 until then.`);
  process.exit(0);
}

mkdirSync(dirname(TARGET), { recursive: true });
copyFileSync(builds[0], TARGET);
console.log(`Copied ${builds[0]} to public/downloads/Klosti.dmg`);
