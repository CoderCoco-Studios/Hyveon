import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

/** Reads a file relative to the `@hyveon/web` package root. */
function readWebFile(relativePath: string): string {
  return readFileSync(path.join(webRoot, relativePath), 'utf8');
}

/**
 * Extracts every `--color-*: <hex>` declaration from the `@theme` block of `index.css`.
 *
 * @returns Map from token name (e.g. `--color-card`) to its lower-cased hex value.
 */
function themeColorTokens(): Map<string, string> {
  const css = readWebFile('src/index.css');
  const theme = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  const tokens = new Map<string, string>();
  for (const [, name, value] of theme.matchAll(/(--color-[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    tokens.set(name!, value!.toLowerCase());
  }
  return tokens;
}

/** Semantic colour names whose Tailwind utilities exist only when a matching `--color-<name>` token is declared. */
const SEMANTIC_COLOR_NAMES = [
  'accent',
  'background',
  'muted',
  'muted-foreground',
  'card',
  'foreground',
  'border',
  'primary',
  'popover',
  'secondary',
  'destructive',
  'red',
];

const SHELL_CHROME_FILES = [
  'src/components/app-layout.component.tsx',
  'src/components/app-topbar.component.tsx',
  'src/components/app-nav.component.tsx',
  'src/components/window-chrome.component.tsx',
];

describe('design tokens', () => {
  // @spec APP-SHELL-UI-004
  it('should declare an @theme token for every semantic colour utility the shell chrome uses', () => {
    const tokens = themeColorTokens();
    const names = SEMANTIC_COLOR_NAMES.join('|');
    const utility = new RegExp(`(?<![\\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke)-(${names})(?![\\w-])`, 'g');
    const missing = new Set<string>();

    for (const file of SHELL_CHROME_FILES) {
      for (const [, name] of readWebFile(file).matchAll(utility)) {
        if (!tokens.has(`--color-${name}`)) missing.add(`${file}: ${name}`);
      }
    }

    expect([...missing]).toEqual([]);
  });

  // @spec APP-SHELL-UI-006
  it('should list in DESIGN.md exactly the colour tokens and values that index.css @theme declares', () => {
    const documented = new Map<string, string>();
    const row = /\|\s*`(--color-[\w-]+)`\s*\|\s*`(#[0-9a-fA-F]{3,8})`/g;
    for (const [, name, value] of readWebFile('DESIGN.md').matchAll(row)) {
      documented.set(name!, value!.toLowerCase());
    }

    expect(Object.fromEntries(documented)).toEqual(Object.fromEntries(themeColorTokens()));
  });
});
