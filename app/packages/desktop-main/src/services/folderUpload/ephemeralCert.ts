import { X509Certificate } from 'node:crypto';
import selfsigned from 'selfsigned';

/** A throwaway TLS identity for one upload-helper launch. */
export interface EphemeralCert {
  certPem: string;
  /** Never logged and never sent to the renderer; delivered to the container only. */
  keyPem: string;
  /** SHA-256 fingerprint of the certificate (`AA:BB:...`), the value the client pins. */
  fingerprint256: string;
}

/** Validity window: well beyond the 2 h helper auto-stop, short enough that a leaked key is near-worthless. */
const CERT_VALIDITY_MS = 24 * 60 * 60 * 1000;
/** Back-dated start so a small clock skew between the operator machine and the helper never rejects the cert. */
const CERT_CLOCK_SKEW_MS = 5 * 60 * 1000;

// @spec HELPER-REACH-003
/**
 * Generates a self-signed P-256 certificate for one helper launch.
 *
 * @remarks
 * The helper's public IP is not known until its ENI exists, which is after the task definition (and so the cert) must
 * be fixed, so the certificate carries a placeholder DNS name and the client pins the fingerprint instead of verifying
 * the hostname.
 */
export async function generateEphemeralCert(now: Date = new Date()): Promise<EphemeralCert> {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'hyveon-seed-helper' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(now.getTime() - CERT_CLOCK_SKEW_MS),
    notAfterDate: new Date(now.getTime() + CERT_VALIDITY_MS),
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'hyveon-seed-helper' }] }],
  });
  return {
    certPem: pems.cert,
    keyPem: pems.private,
    fingerprint256: new X509Certificate(pems.cert).fingerprint256,
  };
}
