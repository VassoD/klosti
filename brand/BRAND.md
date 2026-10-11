# Klosti brand

Klosti comes from κλωστή, Greek for thread. The story is Ariadne's thread: a way out of a labyrinth, here a labyrinth of rule files, skills, hooks and MCP configs.

## Name

- **Klosti** in sentences, titles, the app name, the window title and file names.
- **klosti**, lowercase, only in the logo lockup (mark plus wordmark) and in the command `npx klosti`.

## Logo

A single thread that loops once and runs out to the right, in clay. The source is `app/icon-src/icon.html`. Keep it on paper or card backgrounds; never recolor it per agent.

## Tokens

`brand/tokens.css` is the only place colors, fonts and radii are defined. `node brand/sync.mjs` copies it into the app (`src/template.html`, between the `brand-tokens` markers) and the site (`site/src/app/brand-tokens.css`). The engine and site builds fail when a copy is out of date.

| Role | Tokens | Use |
|---|---|---|
| Surfaces | `--paper`, `--paper-2`, `--card` | Page, sidebar and layers, raised cards |
| Ink | `--ink`, `--ink-2`, `--muted` | Text only |
| Brand | `--clay`, `--clay-soft`, `--clay-ink` | The thread, the logo, primary accents. Not for data series |
| Status | `--high`, `--medium`, `--low`, `--ok` (and `-soft`) | Severity of findings. Always paired with a label |
| Agents | `--claude`, `--codex`, `--cursor`, `--gemini` | Identity dots. Always next to the agent's name |

The agent colors were checked with the dataviz palette validator in the order Claude, Codex, Cursor, Gemini, in both themes. Codex and Cursor are below 3:1 on light surfaces, which is why an agent color never appears without its name.

## Type

- Serif for headings: Iowan Old Style on Macs, Source Serif 4 on the site elsewhere (`--font-serif-web`), then Charter and Georgia.
- System sans for body text.
- SF Mono for paths and commands, JetBrains Mono on the site elsewhere (`--font-mono-web`).

## Visual language

- **Thread:** load order. A clay line runs top to bottom through the layers (Global, Plugins, Project). Rule files are numbered beads on it; items loaded on demand are rings.
- **Knot:** a clash. An arc on the left of the thread ties together the files involved, colored by severity, with a dot where it bends. A knot on a single bead means the other side lives elsewhere.
- **Labyrinth:** marketing only (the site's hero). It stays out of the app.
