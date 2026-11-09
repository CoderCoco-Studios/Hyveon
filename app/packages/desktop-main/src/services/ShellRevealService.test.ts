import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellRevealService } from './ShellRevealService.js';

const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: loggerMock }));

/** Overrides the protected Electron seam so tests observe reveals without a real Electron process. */
class TestableShellRevealService extends ShellRevealService {
  readonly shown: string[] = [];
  failWith: Error | null = null;

  protected override showItemInFolder(path: string): void {
    if (this.failWith) throw this.failWith;
    this.shown.push(path);
  }
}

describe('ShellRevealService', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    loggerMock.warn.mockReset();
    dir = mkdtempSync(join(tmpdir(), 'reveal-'));
    file = join(dir, 'template.yaml');
    writeFileSync(file, 'x');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // @spec APP-SHELL-REVEAL-002
  it('should reveal the path recorded for a known target', () => {
    const service = new TestableShellRevealService();
    service.record('guided-iam-template', file);

    service.reveal('guided-iam-template');

    expect(service.shown).toEqual([file]);
  });

  // @spec APP-SHELL-REVEAL-002
  it.each(['/etc/passwd', '../../secret', '', 42, null, undefined, { path: '/etc/passwd' }])(
    'should refuse the non-target input %j without revealing anything',
    (input) => {
      const service = new TestableShellRevealService();
      service.record('guided-iam-template', file);

      service.reveal(input);

      expect(service.shown).toEqual([]);
      expect(loggerMock.warn).toHaveBeenCalledOnce();
    },
  );

  // @spec APP-SHELL-REVEAL-003
  it('should do nothing and warn for a target with no recorded path', () => {
    const service = new TestableShellRevealService();

    service.reveal('diagnostics-bundle');

    expect(service.shown).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledOnce();
  });

  // @spec APP-SHELL-REVEAL-003
  it('should do nothing and warn when the recorded file no longer exists', () => {
    const service = new TestableShellRevealService();
    service.record('diagnostics-bundle', join(dir, 'gone.zip'));

    service.reveal('diagnostics-bundle');

    expect(service.shown).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledOnce();
  });

  // @spec APP-SHELL-REVEAL-003
  it('should log a normalised message and not throw when the file manager fails', () => {
    const service = new TestableShellRevealService();
    service.record('guided-iam-template', file);
    service.failWith = new Error('no file manager');

    expect(() => service.reveal('guided-iam-template')).not.toThrow();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: 'no file manager' }),
    );
  });

  // @spec APP-SHELL-REVEAL-002
  it('should reveal the most recently recorded path for a target', () => {
    const service = new TestableShellRevealService();
    const second = join(dir, 'second.yaml');
    writeFileSync(second, 'y');
    service.record('guided-iam-template', file);
    service.record('guided-iam-template', second);

    service.reveal('guided-iam-template');

    expect(service.shown).toEqual([second]);
  });
});
