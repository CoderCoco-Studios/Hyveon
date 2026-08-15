import { describe, it, expect } from 'vitest';
import { scrubSecrets } from './diagnosticsLogScrubber.js';

describe('scrubSecrets', () => {
  it('should redact an AWS access-key-id-shaped token', () => {
    const line = '2026-08-14T00:00:00Z INFO using key AKIAABCDEFGHIJKLMNOP for this session';

    const result = scrubSecrets(line);

    expect(result).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(result).toContain('[REDACTED]');
  });

  it('should redact a long token/key/secret-labeled value', () => {
    const line = 'botToken: aG9yc2ViYXR0ZXJ5c3RhcGxlY29ycmVjdGhvcnNl1234567890';

    const result = scrubSecrets(line);

    expect(result).not.toContain('aG9yc2ViYXR0ZXJ5c3RhcGxlY29ycmVjdGhvcnNl1234567890');
    expect(result).toContain('[REDACTED]');
  });

  it('should redact a secret= assignment', () => {
    const line = 'config secret=abcdef0123456789abcdef0123456789 loaded';

    const result = scrubSecrets(line);

    expect(result).not.toContain('abcdef0123456789abcdef0123456789');
  });

  it('should leave a normal log line untouched', () => {
    const line = '2026-08-14T00:00:00Z INFO Server started on port 25565';

    expect(scrubSecrets(line)).toBe(line);
  });

  it('should leave a line with a short, non-secret-shaped word untouched', () => {
    const line = 'the key thing to check is whether the door is locked';

    expect(scrubSecrets(line)).toBe(line);
  });

  it('should scrub multiple occurrences across multi-line text', () => {
    const text = ['line one AKIAABCDEFGHIJKLMNOP', 'line two is fine', 'line three AKIAZYXWVUTSRQPONMLK'].join('\n');

    const result = scrubSecrets(text);

    expect(result).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(result).not.toContain('AKIAZYXWVUTSRQPONMLK');
    expect(result.split('\n')).toHaveLength(3);
  });

  it('should redact an ASIA-prefixed temporary/STS session key', () => {
    const line = '2026-08-14T00:00:00Z INFO using key ASIAABCDEFGHIJKLMNOP for this session';

    const result = scrubSecrets(line);

    expect(result).not.toContain('ASIAABCDEFGHIJKLMNOP');
    expect(result).toContain('[REDACTED]');
  });

  it('should redact the labeled value at its true position even when the value string is duplicated earlier in the line', () => {
    // Regression: a naive `match.indexOf(value)`/`match.replace(value, ...)` redacts the
    // FIRST textual occurrence of the captured secret string anywhere in the match, not the
    // captured group's actual position — so a duplicate substring before the label survives
    // untouched at its real position after `token=`.
    const line = 'abcdefghijklmnop_token=abcdefghijklmnop';

    const result = scrubSecrets(line);

    expect(result).toBe('abcdefghijklmnop_token=[REDACTED]');
  });
});
