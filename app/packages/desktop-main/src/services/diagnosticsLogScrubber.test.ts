import { describe, it, expect } from 'vitest';
import { scrubSecrets } from './diagnosticsLogScrubber.js';

// Assembled at runtime so no literal access-key-id shape sits in the source for secret scanners to flag.
const KEY_ID = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const KEY_ID_2 = ['AKIA', 'ZYXWVUTSRQPONMLK'].join('');
const SESSION_KEY_ID = ['ASIA', 'ABCDEFGHIJKLMNOP'].join('');

describe('scrubSecrets', () => {
  // @spec APP-DIAG-SCRUB-001
  it('should redact an AWS access-key-id-shaped token', () => {
    const line = `2026-08-14T00:00:00Z INFO using key ${KEY_ID} for this session`;

    const result = scrubSecrets(line);

    expect(result).not.toContain(`${KEY_ID}`);
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
    const text = [`line one ${KEY_ID}`, 'line two is fine', `line three ${KEY_ID_2}`].join('\n');

    const result = scrubSecrets(text);

    expect(result).not.toContain(`${KEY_ID}`);
    expect(result).not.toContain(`${KEY_ID_2}`);
    expect(result.split('\n')).toHaveLength(3);
  });

  // @spec APP-DIAG-SCRUB-001
  it('should redact an ASIA-prefixed temporary/STS session key', () => {
    const line = `2026-08-14T00:00:00Z INFO using key ${SESSION_KEY_ID} for this session`;

    const result = scrubSecrets(line);

    expect(result).not.toContain(`${SESSION_KEY_ID}`);
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

    // @spec APP-DIAG-SCRUB-003
    it.each([1, 2, 3, 4])('should redact a labeled value under %i layer(s) of JSON.stringify nesting', (depth) => {
      let line = JSON.stringify({ botToken: SECRET });
      for (let i = 1; i < depth; i++) line = JSON.stringify({ message: line });

      const result = scrubSecrets(line);

      expect(result).not.toContain(SECRET);
      expect(result).toContain('[REDACTED]');
    });

    // @spec APP-DIAG-SCRUB-003
    it('should redact the review-reported triple-nested payload', () => {
      const line = JSON.stringify({ message: JSON.stringify({ payload: JSON.stringify({ botToken: SECRET }) }) });

      expect(scrubSecrets(line)).not.toContain(SECRET);
    });

    // @spec APP-DIAG-SCRUB-003, APP-DIAG-SCRUB-004
    it('should leave unlabeled and short values untouched under deep nesting', () => {
      const neighbour = 'abcdefghijklmnopqrstuvwxyz0123';
      const inner = JSON.stringify({ id: neighbour, apiKey: 'short', tokenCount: '12' });
      const line = JSON.stringify({ message: JSON.stringify({ payload: inner }) });

      expect(scrubSecrets(line)).toBe(line);
    });

    // @spec APP-DIAG-SCRUB-003
    it('should not backtrack catastrophically on a long run of backslashes after a label', () => {
      const line = `token${'\\'.repeat(50_000)}x${'"'.repeat(1000)}`;
      const start = performance.now();

      expect(scrubSecrets(line)).toBe(line);
      expect(performance.now() - start).toBeLessThan(1000);
    });

    // @spec APP-DIAG-SCRUB-003, APP-DIAG-SCRUB-004
    it('should leave a short JSON-quoted labeled value untouched', () => {
      const line = '{"apiKey":"short","tokenCount":"12"}';

      expect(scrubSecrets(line)).toBe(line);
    });
  });

  describe('real token shapes', () => {
    const DISCORD_ID = 'MTIzNDU2Nzg5MDEyMzQ1Njc4';
    const DISCORD_TS = 'GabcDe';
    const DISCORD_HMAC = 'x7Yk2mQp9RtVw3Zb5Nc8Ld1Fg4H';
    const DISCORD_TOKEN = `${DISCORD_ID}.${DISCORD_TS}.${DISCORD_HMAC}`;
    const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYzZpQ4a9Lkd';
    const SIGNATURE = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

    // @spec APP-DIAG-SCRUB-006
    it('should redact a whole labelled Discord token including its dotted segments', () => {
      const result = scrubSecrets(`login failed botToken=${DISCORD_TOKEN} for guild`);

      expect(result).not.toContain(DISCORD_TS);
      expect(result).not.toContain(DISCORD_HMAC);
      expect(result).toContain('botToken=[REDACTED]');
    });

    // @spec APP-DIAG-SCRUB-006
    it('should redact an unlabelled Discord token', () => {
      const result = scrubSecrets(`unexpected response for ${DISCORD_TOKEN}`);

      expect(result).not.toContain(DISCORD_HMAC);
    });

    // @spec APP-DIAG-SCRUB-007
    it.each(['Bearer', 'Bot', 'Basic'])('should redact an Authorization header with the %s scheme', (scheme) => {
      const result = scrubSecrets(`headers: { Authorization: ${scheme} ${DISCORD_TOKEN} }`);

      expect(result).not.toContain(DISCORD_HMAC);
      expect(result.toLowerCase()).toContain('authorization');
    });

    // @spec APP-DIAG-SCRUB-007
    it('should redact a bare Bearer credential', () => {
      const result = scrubSecrets('retrying with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl');

      expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    // @spec APP-DIAG-SCRUB-008
    it('should redact presigned URL signature, security token and credential parameters in full', () => {
      const url =
        `https://b.s3.amazonaws.com/k?X-Amz-Credential=${KEY_ID}%2F20261108%2Fus-east-1%2Fs3%2Faws4_request` +
        `&X-Amz-Signature=${SIGNATURE}&X-Amz-Security-Token=IQoJb3JpZ2luX2VjE%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3Qt%2Bxyz&X-Amz-Expires=300`;

      const result = scrubSecrets(url);

      expect(result).not.toContain(SIGNATURE);
      expect(result).not.toContain('IQoJb3JpZ2luX2VjE');
      expect(result).not.toContain('Bxyz');
      expect(result).not.toContain('20261108');
      expect(result).toContain('X-Amz-Expires=300');
    });

    // @spec APP-DIAG-SCRUB-009
    it.each([
      ['passphrase=correct-horse-9', 'correct-horse-9'],
      ['password: "hunter2hunter2"', 'hunter2hunter2'],
      ['db_password=s3cr3t-x', 's3cr3t-x'],
    ])('should redact a password or passphrase label: %s', (text, value) => {
      expect(scrubSecrets(text)).not.toContain(value);
    });

    // @spec APP-DIAG-SCRUB-009
    it('should redact a short labelled value of six or more characters', () => {
      expect(scrubSecrets('token=short1234')).toBe('token=[REDACTED]');
    });

    // @spec APP-DIAG-SCRUB-010
    it('should redact an unlabelled 40-character AWS secret access key next to an access key id', () => {
      const result = scrubSecrets(`creds ${KEY_ID} ${AWS_SECRET} loaded`);

      expect(result).not.toContain(AWS_SECRET);
      expect(result).toContain('creds');
      expect(result).toContain('loaded');
    });

    // @spec APP-DIAG-SCRUB-010
    it('should leave a 40-character base64-ish string alone when no access key id is nearby', () => {
      const line = `object hash ${AWS_SECRET}`;

      expect(scrubSecrets(line)).toBe(line);
    });

    // @spec APP-DIAG-SCRUB-003
    it('should keep redacting JSON-quoted labelled values', () => {
      expect(scrubSecrets('{"botToken":"abcdefghijklmnopqrstuvwx"}')).not.toContain('abcdefghijklmnopqrstuvwx');
    });
  });
});
