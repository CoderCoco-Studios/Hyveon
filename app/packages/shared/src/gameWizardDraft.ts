/**
 * In-progress add-game wizard field values as persisted by the main process and carried over IPC. Not
 * secret in the general case, but may contain operator-entered environment
 * variable values the operator considers sensitive — see
 * {@link StoredGameWizardDraft}'s doc comment for the at-rest posture this
 * accepts.
 */
export interface GameWizardDraft {
  name: string;
  image: string;
  connect_message: string;
  cpu: number | null;
  memory: number | null;
  /** Absent on a draft autosaved before `visibility` existed — `GameWizardDraftService` backfills `'public'` on read. */
  ports: { container: number | null; protocol: string; visibility?: 'public' | 'internal' }[];
  volumes: { name: string; container_path: string }[];
  file_seeds: { path: string; content: string; content_base64: string; mode: string }[];
  environment: { name: string; value: string }[];
  https: boolean;
  /**
   * Caddy upstream port for an https draft. Absent on a draft autosaved before this field existed —
   * `GameWizardDraftService` normalises a legacy https draft (`ports[0]` as upstream) on read.
   */
  webPort?: number | null;
  /** Absent on a draft autosaved before this field existed — `GameWizardDraftService` backfills `[]` on read. */
  command?: string[];
  /** Absent when the "Pin hostname" switch is off. */
  pinnedHostname?: string;
  /** Absent on a draft autosaved before this field existed — `GameWizardDraftService` backfills a default on read. */
  healthCheck?: {
    enabled: boolean;
    scheme: string;
    port: number | null;
    path: string;
    method: string;
    timeoutMs: number | null;
    jsonPath: string;
    operator: string;
    value: string;
    /** Absent on a draft autosaved before `authType`/`username`/`password`/`token` existed — `GameWizardDraftService` backfills a default on read. */
    authType?: 'none' | 'raw' | 'basic' | 'bearer';
    secretArn: string;
    username?: string;
    password?: string;
    token?: string;
    secretSet: boolean;
  };
}

/**
 * A saved add-game wizard draft plus which step the operator was on and
 * when it was last autosaved. Written/read via
 * `GameWizardDraftService`, never directly through
 * `ElectronStoreService` get/set from
 * outside that service.
 *
 * @remarks
 * Stored in plaintext, matching the storage posture of the eventual
 * `deployment-config.json` write this draft becomes on submit — neither is
 * field-level encrypted, unlike the AWS credentials and passphrase held in
 * the electron store, which are genuine secrets. However, `GameWizardDraftService.get()`
 * blanks out `environment[].value` and `file_seeds[].content`/`content_base64`
 * before returning a stored entry to a caller, so those operator-entered
 * values never reach the renderer over IPC even though they're written to
 * disk here — the operator re-enters them on resume. `GameWizardDraftService.save()`
 * still persists the full, unredacted draft; only reads are redacted.
 */
export interface StoredGameWizardDraft {
  draft: GameWizardDraft;
  stepIndex: number;
  /** ISO-8601 timestamp of the most recent autosave. */
  savedAt: string;
}

/**
 * A {@link GameWizardDraft} with every field the main process backfills on read made required, so a consumer of
 * `games.draft.get` (and the renderer's form state) never handles a missing optional field.
 */
export type ResolvedGameWizardDraft = Omit<GameWizardDraft, 'ports' | 'webPort' | 'command' | 'healthCheck'> & {
  ports: (Omit<GameWizardDraft['ports'][number], 'visibility'> & { visibility: 'public' | 'internal' })[];
  webPort: number | null;
  command: string[];
  healthCheck: Required<NonNullable<GameWizardDraft['healthCheck']>>;
};

/** A {@link StoredGameWizardDraft} whose `draft` is the backfilled {@link ResolvedGameWizardDraft}, as returned by `games.draft.get`. */
export interface StoredResolvedGameWizardDraft {
  draft: ResolvedGameWizardDraft;
  stepIndex: number;
  savedAt: string;
}
