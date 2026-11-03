import { describe, it, expect } from 'vitest';
import { scrubSecrets } from './diagnosticsLogScrubber.js';

describe('scrubSecrets', () => {
  // @spec APP-DIAG-SCRUB-001
  it('should redact an AWS access-key-id-shaped token', () => {
    const line = '2026-08-14T00:00:00Z INFO using key AKIAABCDEFGHIJKLMNOP for this session';

    const result = scrubSecrets(line);

    expect(result).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(result).toContain('[REDACTED]');
  });

  // @spec APP-DIAG-SCRUB-002
  it('should redact a long token/key/secret-labeled value', () => {
    const line = 'botToken: aG9yc2ViYXR0ZXJ5c3RhcGxlY29ycmVjdGhvcnNl1234567890';

    const result = scrubSecrets(line);

    expect(result).not.toContain('aG9yc2ViYXR0ZXJ5c3RhcGxlY29ycmVjdGhvcnNl1234567890');
    expect(result).toContain('[REDACTED]');
  });

  // @spec APP-DIAG-SCRUB-002
  it('should redact a secret= assignment', () => {
    const line = 'config secret=abcdef0123456789abcdef0123456789 loaded';

    const result = scrubSecrets(line);

    expect(result).not.toContain('abcdef0123456789abcdef0123456789');
  });

  // @spec APP-DIAG-SCRUB-004
  it('should leave a normal log line untouched', () => {
    const line = '2026-08-14T00:00:00Z INFO Server started on port 25565';

    expect(scrubSecrets(line)).toBe(line);
  });

  // @spec APP-DIAG-SCRUB-004
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

  // @spec APP-DIAG-SCRUB-001
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

  describe('JSON-quoted labeled values', () => {
    const SECRET = 'aG9yc2ViYXR0ZXJ5c3RhcGxlY29ycmVjdA';

    // @spec APP-DIAG-SCRUB-003
    it('should redact a compact production json() value', () => {
      const line = `{"level":"info","message":"saved","botToken":"${SECRET}"}`;

      expect(scrubSecrets(line)).toBe('{"level":"info","message":"saved","botToken":"[REDACTED]"}');
    });

    // @spec APP-DIAG-SCRUB-003
    it('should redact a dev meta value with a space after the colon', () => {
      const line = `saved {"apiKey": "${SECRET}"}`;

      expect(scrubSecrets(line)).toBe('saved {"apiKey": "[REDACTED]"}');
    });

    // @spec APP-DIAG-SCRUB-003
    it('should redact a single-quoted label and value', () => {
      const line = `{'apiKey': '${SECRET}'}`;

      expect(scrubSecrets(line)).toBe("{'apiKey': '[REDACTED]'}");
    });

    // @spec APP-DIAG-SCRUB-003
    it('should redact a value nested inside another object', () => {
      const line = `{"meta":{"discord":{"publicKey":"${SECRET}"}}}`;

      expect(scrubSecrets(line)).toBe('{"meta":{"discord":{"publicKey":"[REDACTED]"}}}');
    });

    // @spec APP-DIAG-SCRUB-003
    it('should redact a value inside a JSON string with escaped quotes', () => {
      const line = String.raw`{"message":"payload {\"botToken\":\"${SECRET}\"}"}`;

      expect(scrubSecrets(line)).toBe(String.raw`{"message":"payload {\"botToken\":\"[REDACTED]\"}"}`);
    });

    // @spec APP-DIAG-SCRUB-003
    it('should redact every labeled value on one line but leave unlabeled neighbours', () => {
      const neighbour = 'abcdefghijklmnopqrstuvwxyz0123';
      const line = `{"id":"${neighbour}","botToken":"${SECRET}","name":"${neighbour}","clientSecret":"${SECRET}"}`;

      expect(scrubSecrets(line)).toBe(
        `{"id":"${neighbour}","botToken":"[REDACTED]","name":"${neighbour}","clientSecret":"[REDACTED]"}`,
      );
    });

    // @spec APP-DIAG-SCRUB-003, APP-DIAG-SCRUB-004
    it('should leave a short JSON-quoted labeled value untouched', () => {
      const line = '{"apiKey":"short","tokenCount":"12"}';

      expect(scrubSecrets(line)).toBe(line);
    });
  });
});
