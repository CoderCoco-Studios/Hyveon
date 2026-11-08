import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WindowControls } from './window-chrome.component.js';

/** Installs a Linux `window.hyveon.window` stub so `WindowControls` draws its buttons. */
function stubLinuxWindowBridge(): void {
  vi.stubGlobal('hyveon', {
    window: {
      platform: 'linux',
      minimize: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      isMaximized: vi.fn().mockResolvedValue(false),
      onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
    },
  });
}

describe('WindowControls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // @spec APP-SHELL-UI-005
  it('should colour the close button hover with the --color-red token, not a raw Tailwind palette red', () => {
    stubLinuxWindowBridge();

    render(<WindowControls />);

    const className = screen.getByRole('button', { name: 'Close' }).className;
    expect(className).toMatch(/hover:text-red\b/);
    expect(className).toMatch(/hover:bg-red\/10/);
    expect(className).not.toMatch(/red-\d{3}/);
  });
});
