/**
 * Outcome of one access-key rotation (mint a new key, verify it, store it, revoke the old one), modeled as a
 * discriminated union rather than thrown errors: `verification-failed` and `delete-failed` are expected, recoverable
 * states the operator must see rendered distinctly.
 */
export type KeyRotationOutcome =
  /** The new key pair is active and the old key has been revoked. */
  | { status: 'complete' }
  /** The new key failed verification on every retry; nothing became active and the previous key is still in use. */
  | { status: 'verification-failed'; error: string }
  /** The new key is active, but the old key could not be deleted: revoke it manually via `consoleUrl`. */
  | { status: 'delete-failed'; consoleUrl: string };

/**
 * Outcome of the guided-IAM rotation channel: {@link KeyRotationOutcome} plus the modeled refusal for an unavailable
 * OS keychain, which is raised before any AWS call.
 */
export type GuidedIamRotateResult = KeyRotationOutcome | { status: 'keychain-unavailable' };

/**
 * Outcome of the in-app key-rotation channel: {@link GuidedIamRotateResult} plus the modeled refusals, so the IPC call
 * never rejects.
 */
export type AwsKeyRotateResult =
  | GuidedIamRotateResult
  /** The active credential source is a `~/.aws` profile or unset, which the app does not rotate. */
  | { status: 'unsupported'; message: string }
  /** A Pulumi operation is running; rotating now would revoke the key it is using and strand its backend lock. */
  | { status: 'busy' }
  /** An unexpected AWS or store failure. */
  | { status: 'failed'; message: string };
