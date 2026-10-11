import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Serif_4 } from "next/font/google";

import "./globals.css";

const serif = Source_Serif_4({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-serif" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "klosti",
  description:
    "See every rule, skill, hook and MCP server your coding agents use, where each one applies, and what contradicts. For Claude Code, Codex, Cursor and Gemini.",
  openGraph: {
    title: "klosti: a thread through your agent setup",
    description: "Maps the rules, skills, hooks and MCP servers Claude Code, Codex, Cursor and Gemini load on your Mac.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f4ef" },
    { media: "(prefers-color-scheme: dark)", color: "#191816" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" className={`${serif.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
