# Architecture diagrams (D2)

Each `.d2` file here is one diagram. `docs/diagrams/render.sh` renders every
`.d2` source to SVG under `docs/static/diagrams/`. The Docusaurus site
(`.github/workflows/docusaurus-gh-pages.yml`) runs `bash docs/diagrams/render.sh`
and then `npm run build` (in `docs/`) on every push to `main` that touches
`docs/**`; the Markdown pages reference the generated `.svg` files via
standard image tags (`/diagrams/<name>.svg`).

The `.d2` files are the source of truth for diagram *content*, but the
rendered SVGs are **committed** to `docs/static/diagrams/` — `docs/diagrams/.gitignore`
only ignores `*.svg` in this source directory, not the output directory. If
you edit a `.d2` file, re-run `./render.sh` and commit the regenerated SVG
alongside your change, or the docs site will keep shipping the stale image
until the next `main` build.

## Files

| File | Embedded on |
|------|-------------|
| `context.d2`        | `docs/docs/intro.md` — high-level context |
| `discord-bot.d2`    | `docs/docs/architecture.md` — serverless Discord bot detail |
| `game-plane.d2`     | `docs/docs/architecture.md` — operator + ECS + EFS |
| `control-loops.d2`  | `docs/docs/architecture.md` — update-dns + watchdog |
| `server-start.d2`   | `docs/docs/architecture.md` — `/server-start` sequence |

## Edit + preview locally

```bash
# One-time: install D2 (https://d2lang.com)
curl -fsSL https://d2lang.com/install.sh | sh -s --

# Render every .d2 -> .svg (writes to docs/static/diagrams/)
./render.sh

# Preview the docs site
cd docs
npm start
```

## Why D2 instead of Mermaid?

Mermaid's dagre layout routes every cross-cluster edge through whatever
subgraphs sit between the endpoints, producing unreadable overlap on
diagrams with more than a handful of nodes. D2 uses ELK by default and
handles the same graphs much more cleanly. Smaller diagrams with fewer
cross-cluster edges also help — this directory splits the old single
overview into focused diagrams.
