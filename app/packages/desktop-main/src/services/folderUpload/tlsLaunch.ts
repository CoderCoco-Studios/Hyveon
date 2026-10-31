import type { EphemeralCert } from './ephemeralCert.js';

/** Container settings that make FileBrowser serve HTTPS with a per-launch certificate. */
export interface TlsContainerSettings {
  entryPoint: string[];
  command: string[];
  environment: { name: string; value: string }[];
}

// @spec HELPER-REACH-003
/**
 * Wraps FileBrowser's arguments so the container writes the base64 env-provided certificate and key to files and execs
 * FileBrowser with `--cert/--key`.
 *
 * @remarks
 * Verified against `filebrowser/filebrowser` `v2.63.23`: `/bin/sh`, `base64` and `filebrowser` are on PATH, `/tmp` is writable by
 * the image's uid 1000 user, and `--cert/--key` serve HTTPS. It is deliberately the only place that knows how TLS is wired
 * so it can be replaced by a Caddy sidecar without touching the launch flow.
 *
 * @param filebrowserArgs - The flags normally passed as the container command.
 * @param cert - The launch's certificate and key.
 */
export function buildTlsContainerSettings(filebrowserArgs: string[], cert: EphemeralCert): TlsContainerSettings {
  const script =
    'printf %s "$FB_TLS_CERT_B64" | base64 -d > /tmp/tls.crt && ' +
    'printf %s "$FB_TLS_KEY_B64" | base64 -d > /tmp/tls.key && ' +
    'exec filebrowser --cert /tmp/tls.crt --key /tmp/tls.key "$@"';
  return {
    entryPoint: ['sh', '-c'],
    command: [script, 'filebrowser', ...filebrowserArgs],
    environment: [
      { name: 'FB_TLS_CERT_B64', value: Buffer.from(cert.certPem).toString('base64') },
      { name: 'FB_TLS_KEY_B64', value: Buffer.from(cert.keyPem).toString('base64') },
    ],
  };
}
