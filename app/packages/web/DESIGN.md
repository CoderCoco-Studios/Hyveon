# Design Tokens — Ops Dashboard

Datadog-style dark ops aesthetic. All tokens are defined as CSS custom properties in `src/index.css` under `@theme` (Tailwind v4) and can be referenced directly via `var(--token-name)` or as Tailwind utility classes.

---

## Colors

### Background / Surface scale

| Token | Value | Usage |
|---|---|---|
| `--color-bg` | `#0f1117` | Page background |
| `--color-surface` | `#1a1d2e` | Card / panel background |
| `--color-surface-2` | `#252a40` | Nested surfaces, input backgrounds, hover fills |
| `--color-border` | `#2e3350` | Borders, dividers, separators |
| `--color-card` | `#1a1d2e` | Sidebar, mobile drawer and header background (same value as `--color-surface`) |
| `--color-background` | `#0f1117` | App root background (same value as `--color-bg`) |
| `--color-muted` | `#252a40` | Muted fills such as the LIVE pill (same value as `--color-surface-2`) |
| `--color-accent` | `#252a40` | Hover fill for icon buttons and nav entries (same value as `--color-surface-2`); distinct from the legacy `--accent` var, which is the brand purple |

### Foreground

| Token | Value | Usage |
|---|---|---|
| `--color-foreground` | `#e1e4ed` | Primary text |
| `--color-muted-foreground` | `#9398ad` | Secondary / metadata text |

### Accent palette

| Token | Value | Usage |
|---|---|---|
| `--color-primary` | `#7c3aed` | Purple — primary actions, focus rings |
| `--color-primary-light` | `#a78bfa` | Purple light — hover states, links, cost highlight |
| `--color-cyan` | `#06b6d4` | Cyan — info, DNS, networking |
| `--color-cyan-light` | `#67e8f9` | Cyan light — text on dark cyan |
| `--color-orange` | `#f97316` | Orange — warnings, cost alerts |
| `--color-pink` | `#ec4899` | Pink — decorative, Discord accent |

### Status colors

| Token | Value | Usage |
|---|---|---|
| `--color-green` | `#4ade80` | Running / online / success |
| `--color-amber` | `#fbbf24` | Starting / not deployed / warning |
| `--color-red` | `#f87171` | Stopped / error / destructive |

---

## Typography

| Role | Font | CSS token | Usage |
|---|---|---|---|
| UI | **Outfit** (300–700) | `--font-ui` | All body text, labels, headings, buttons |
| Data / Mono | **DM Mono** (300–500) | `--font-mono` | IDs, IP addresses, timestamps, terminal output, inputs |

Both fonts are loaded via Google Fonts in `index.html`.

`font-feature-settings: 'tnum'` is set globally on `body` so numbers align in tables and metric displays.

---

## Spacing

Tailwind's default 4px-base spacing scale is used throughout (`p-3` = 12px, `p-5` = 20px, `gap-2` = 8px, etc.). No custom spacing tokens are defined.

---

## Border Radius

| Token | Value | Tailwind equivalent | Usage |
|---|---|---|---|
| `--radius-sm` | `6px` | — | Buttons, badges, small inputs |
| `--radius-md` | `8px` | — | Menus, popovers, tooltips |
| `--radius-lg` | `10px` | — | Cards, modals, dialogs |

Maximum radius is 10px — no 12px+ rounding.

---

## shadcn/ui Components

The following primitives are installed under `src/components/ui/`:

| Component | File | Radix primitive |
|---|---|---|
| Button | `button.tsx` | `@radix-ui/react-slot` |
| Badge | `badge.tsx` | — |
| Card | `card.tsx` | — |
| Dialog | `dialog.tsx` | `@radix-ui/react-dialog` |
| Dropdown Menu | `dropdown-menu.tsx` | `@radix-ui/react-dropdown-menu` |
| Tooltip | `tooltip.tsx` | `@radix-ui/react-tooltip` |
| Input | `input.tsx` | — |
| Label | `label.tsx` | `@radix-ui/react-label` |
| Tabs | `tabs.tsx` | `@radix-ui/react-tabs` |
| Table | `table.tsx` | — |
| Select | `select.tsx` | `@radix-ui/react-select` |
| Alert Dialog | `alert-dialog.tsx` | `@radix-ui/react-alert-dialog` |
| Toast (Sonner) | `sonner.tsx` | `sonner` |

Icons come from **lucide-react**.

---

## Button variants

| Variant | Description |
|---|---|
| `default` | Purple fill — primary CTA |
| `secondary` | Surface-2 fill — secondary actions |
| `outline` | Transparent + border — tertiary |
| `ghost` | No border, hover fill only |
| `destructive` | Red fill — dangerous actions |
| `start` | Green fill — start server |
| `stop` | Red fill — stop server |
| `link` | Underline style |

Sizes: `sm` (h-7), `default` (h-9), `lg` (h-10), `icon` (h-9 w-9).
