import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ShellController } from './shell.controller.js';
import type { ShellRevealService } from '../services/ShellRevealService.js';
import { expectChannels } from '../testing/message-pattern.test-utils.js';

const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: loggerMock }));

/** Builds a ShellRevealService stub. */
function makeReveal(): ShellRevealService {
  return { reveal: vi.fn() } as Partial<ShellRevealService> as ShellRevealService;
}

describe('ShellController', () => {
  // @spec APP-SHELL-REVEAL-001
  it('should register the shell.revealInFolder channel', () => {
    expectChannels(ShellController.prototype, [['revealInFolder', 'shell.revealInFolder']] as const);
  });

  // @spec APP-SHELL-REVEAL-001, APP-SHELL-REVEAL-004
  it('should log on entry and delegate the target to ShellRevealService', () => {
    const reveal = makeReveal();

    new ShellController(reveal).revealInFolder({ target: 'guided-iam-template' });

    expect(loggerMock.debug).toHaveBeenCalledWith('ShellController: shell.revealInFolder invoked', {
      target: 'guided-iam-template',
    });
    expect(reveal.reveal).toHaveBeenCalledWith('guided-iam-template');
  });

  // @spec APP-SHELL-REVEAL-002, APP-SHELL-REVEAL-004
  it('should pass a hostile payload to the service unchanged but truncate it in the log line', () => {
    const reveal = makeReveal();
    const hostile = '/'.repeat(500);

    new ShellController(reveal).revealInFolder({ target: hostile });

    expect(loggerMock.debug).toHaveBeenLastCalledWith('ShellController: shell.revealInFolder invoked', {
      target: '/'.repeat(64),
    });
    expect(reveal.reveal).toHaveBeenCalledWith(hostile);
  });

  // @spec APP-SHELL-REVEAL-001
  it('should tolerate a missing payload', () => {
    const reveal = makeReveal();

    expect(() => new ShellController(reveal).revealInFolder(undefined as never)).not.toThrow();
    expect(reveal.reveal).toHaveBeenCalledWith(undefined);
  });
});
