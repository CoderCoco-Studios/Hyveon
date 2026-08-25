/**
 * Load/save state machine for the deployment-settings editor
 * (`deployment-settings-form.component.tsx`'s "General" section). Reads and
 * writes every top-level `DeploymentConfig` field EXCEPT `gameServers` —
 * region, hosted zone, DNS TTL, watchdog tuning, Discord admin allowlists,
 * Discord application ID, and the audit/runs table name overrides.
 * `gameServers` keeps its own dedicated add-game-wizard/edit-game-form flow
 * and is never reachable from this hook.
 *
 * Mirrors `EditGameForm`'s (`edit-game-form.component.tsx`) established
 * shape rather than inventing a new one:
 *  - A draft is loaded from the server on mount, edited locally, and
 *    submitted as a single patch.
 *  - Client-side validation runs live against the shared
 *    `validateDeploymentSettingsPatch` (`@hyveon/shared`) — the SAME
 *    function `IacSettingsController.update` runs server-side, so the two
 *    can never phrase a rule differently (mirrors `wizard-form.utils.ts`'s
 *    `validateWizardDraft` delegating to the shared `validateGameServer`).
 *  - A `code: 'validation'` server rejection re-renders the same fields with
 *    the server-reported issues instead of a generic failure banner.
 *
 * ## Optimistic locking
 *
 * Unlike the game-server CRUD flow (where `expectedVersionId` is an
 * opt-in caller convenience), this form ALWAYS sends the etag it last read
 * as `expectedVersionId` — silently clobbering a concurrent edit is exactly
 * what optimistic locking exists to prevent for a live settings form. A
 * `code: 'conflict'` result surfaces a "this setting was changed elsewhere
 * since you loaded this page — reload and try again" message and does NOT
 * silently retry or overwrite — mirroring how `EditGameForm`'s `handleSave`
 * routes every `GameWriteResult` failure branch to an inline, non-destructive
 * UI reaction rather than a silent retry.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  DEPLOYMENT_CONFIG_DEFAULTS,
  validateDeploymentSettingsPatch,
  type DeploymentSettingsGetResult,
  type DeploymentSettingsValidationIssue,
  type TopLevelDeploymentSettings,
} from '@hyveon/shared';

/**
 * Draft form of {@link TopLevelDeploymentSettings}: every field held as a
 * raw string (scalars) or `string[]` (the three Discord ID lists) so an
 * in-progress or cleared field can be represented and re-parsed on submit —
 * mirrors `EditGameForm`'s own raw-string draft convention
 * (`edit-game-form.component.tsx`).
 */
export interface SettingsDraft {
  projectName: string;
  awsRegion: string;
  vpcCidr: string;
  hostedZoneName: string;
  dnsTtl: string;
  watchdogIntervalMinutes: string;
  watchdogIdleChecks: string;
  watchdogMinPackets: string;
  baseAllowedGuilds: string[];
  baseAdminUserIds: string[];
  baseAdminRoleIds: string[];
  discordApplicationId: string;
  auditTableName: string;
  runsTableName: string;
}

/** `useDeploymentSettings`'s initial-load outcome, driving which body the component renders. */
export type LoadState = 'loading' | 'loaded' | 'setup_incomplete' | 'error';

/** Return shape of {@link useDeploymentSettings}. */
export interface UseDeploymentSettingsResult {
  /** Current editable draft, or `null` before the initial load resolves. */
  draft: SettingsDraft | null;
  /** Outcome of the initial (or last retried) load. */
  loadState: LoadState;
  /** User-facing message for `loadState === 'setup_incomplete' | 'error'`. */
  loadMessage: string | null;
  /** Every outstanding validation issue — server-reported if present, else live client-side. */
  issues: DeploymentSettingsValidationIssue[];
  /** Whether a save is in flight. */
  submitting: boolean;
  /** Inline error from the last failed save attempt (non-conflict, non-validation). */
  submitError: string | null;
  /** Set when the last save was rejected with `code: 'conflict'`; cleared by editing the draft or reloading. */
  conflictMessage: string | null;
  /** Whether the Save action should be disabled (`!draft || issues.length > 0 || submitting`). */
  saveDisabled: boolean;
  /** Applies a partial patch to the draft, clearing any stale server-reported error state. */
  patchDraft: (patch: Partial<SettingsDraft>) => void;
  /** Submits the draft via `iac.settings.update` — see the module doc's "Optimistic locking" section. */
  save: () => Promise<void>;
  /** Re-fetches settings for the "Retry"/"Reload" actions. */
  reload: () => void;
}

/**
 * Builds a {@link SettingsDraft} from the server-loaded settings — the
 * inverse of {@link draftToPatch}.
 *
 * Every field falls back to `DEPLOYMENT_CONFIG_DEFAULTS` (or `[]` for the
 * three array fields, `''` for `hostedZoneName`, which has no default) when
 * absent — defense in depth on top of `DeploymentConfigService.getTopLevelSettings()`
 * already running the parsed document through `withDeploymentConfigDefaults`
 * server-side: `window.hyveon.iac.settings.get()`'s declared return type is
 * exactly that, a TYPE, not a runtime guarantee — a stale preload build, an
 * intercepted/mocked IPC response in a test, or a future regression in the
 * server-side defaulting could all still hand this function an incomplete
 * object. Without this, an array field's `.map(...)` in a consumer would
 * throw on `undefined` and white-screen the whole `/settings` route, and the
 * numeric fields would render the literal string `"undefined"` via a bare
 * `String(undefined)`.
 */
function draftFromSettings(settings: TopLevelDeploymentSettings): SettingsDraft {
  return {
    projectName: settings.projectName ?? DEPLOYMENT_CONFIG_DEFAULTS.projectName,
    awsRegion: settings.awsRegion ?? DEPLOYMENT_CONFIG_DEFAULTS.awsRegion,
    vpcCidr: settings.vpcCidr ?? DEPLOYMENT_CONFIG_DEFAULTS.vpcCidr,
    // hostedZoneName has no default in DEPLOYMENT_CONFIG_DEFAULTS (required in
    // every real deployment) — an absent value falls back to '', which the form's own
    // "must not be empty" validation then correctly flags rather than this
    // function inventing a fake placeholder domain.
    hostedZoneName: settings.hostedZoneName ?? '',
    dnsTtl: String(settings.dnsTtl ?? DEPLOYMENT_CONFIG_DEFAULTS.dnsTtl),
    watchdogIntervalMinutes: String(
      settings.watchdogIntervalMinutes ?? DEPLOYMENT_CONFIG_DEFAULTS.watchdogIntervalMinutes,
    ),
    watchdogIdleChecks: String(settings.watchdogIdleChecks ?? DEPLOYMENT_CONFIG_DEFAULTS.watchdogIdleChecks),
    watchdogMinPackets: String(settings.watchdogMinPackets ?? DEPLOYMENT_CONFIG_DEFAULTS.watchdogMinPackets),
    baseAllowedGuilds: settings.baseAllowedGuilds ?? [],
    baseAdminUserIds: settings.baseAdminUserIds ?? [],
    baseAdminRoleIds: settings.baseAdminRoleIds ?? [],
    discordApplicationId: settings.discordApplicationId ?? DEPLOYMENT_CONFIG_DEFAULTS.discordApplicationId,
    auditTableName: settings.auditTableName ?? DEPLOYMENT_CONFIG_DEFAULTS.auditTableName,
    runsTableName: settings.runsTableName ?? DEPLOYMENT_CONFIG_DEFAULTS.runsTableName,
  };
}

/**
 * Converts a {@link SettingsDraft} into the `Partial<TopLevelDeploymentSettings>`
 * patch submitted to `iac.settings.update` — the inverse of
 * {@link draftFromSettings}. Numeric fields parse via `Number(...)`;
 * non-numeric or blank input parses to `NaN`/`0`, which
 * {@link validateDeploymentSettingsPatch}'s positive-integer check then
 * rejects as a normal field issue rather than this function silently
 * coercing it. `auditTableName`/`runsTableName` are submitted as-is
 * (including empty) — see the module doc's "empty-string-means-
 * computed-default" handling.
 */
function draftToPatch(draft: SettingsDraft): Partial<TopLevelDeploymentSettings> {
  return {
    projectName: draft.projectName.trim(),
    awsRegion: draft.awsRegion.trim(),
    vpcCidr: draft.vpcCidr.trim(),
    hostedZoneName: draft.hostedZoneName.trim(),
    dnsTtl: Number(draft.dnsTtl),
    watchdogIntervalMinutes: Number(draft.watchdogIntervalMinutes),
    watchdogIdleChecks: Number(draft.watchdogIdleChecks),
    watchdogMinPackets: Number(draft.watchdogMinPackets),
    baseAllowedGuilds: draft.baseAllowedGuilds,
    baseAdminUserIds: draft.baseAdminUserIds,
    baseAdminRoleIds: draft.baseAdminRoleIds,
    discordApplicationId: draft.discordApplicationId.trim(),
    auditTableName: draft.auditTableName.trim(),
    runsTableName: draft.runsTableName.trim(),
  };
}

/**
 * Whether `window.hyveon.iac.settings` is reachable. Guards every access to
 * that namespace (lazy initial state, the mount effect, and {@link
 * UseDeploymentSettingsResult.reload}) with the SAME check, since
 * `window.hyveon` itself can exist without `.iac.settings` on it — e.g. the
 * chromium Playwright tier's `installHyveonHttpBridge()` shim
 * (`e2e/fixtures/hyveon-http-bridge.ts`) installs `window.hyveon` with no
 * `iac` namespace at all. Checking only `!window.hyveon` and then
 * unconditionally accessing `window.hyveon.iac.settings.get()` would throw
 * synchronously on that namespace-less stub.
 */
function hasSettingsBridge(): boolean {
  return !!window.hyveon?.iac?.settings;
}

/** Owns the deployment-settings load/save state machine — see the module doc for the full contract. */
export function useDeploymentSettings(): UseDeploymentSettingsResult {
  const [etag, setEtag] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  // The "no bridge" case is settled synchronously via the lazy initial
  // value, rather than a `setLoadState('error')` call inside the mount
  // effect below — this avoids both a throwaway render and the
  // `react-hooks/set-state-in-effect` violation that a synchronous setState
  // call from inside an effect body triggers (mirrors `useWizardCompleted`'s
  // identical `useState(() => ...)` pattern in `app.component.tsx`).
  const [loadState, setLoadState] = useState<LoadState>(() => (hasSettingsBridge() ? 'loading' : 'error'));
  const [loadMessage, setLoadMessage] = useState<string | null>(() =>
    hasSettingsBridge() ? null : 'IPC bridge (window.hyveon) is not available in this context.',
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<DeploymentSettingsValidationIssue[] | null>(null);

  // Guards stale post-await setState; re-armed at mount so StrictMode's discarded first mount doesn't leave this false forever.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Applies a fetched `iac.settings.get()` result to state. Called only from
   * a promise `.then()` callback (the mount effect below, and
   * {@link reload}'s own fetch) — never synchronously from inside an effect
   * body itself, which is what keeps this clear of
   * `react-hooks/set-state-in-effect`.
   */
  const applyGetResult = useCallback((result: DeploymentSettingsGetResult) => {
    if (!mountedRef.current) return;
    if (result.ok) {
      setEtag(result.etag);
      setDraft(draftFromSettings(result.settings));
      setLoadState('loaded');
      setConflictMessage(null);
      setServerIssues(null);
      setSubmitError(null);
    } else {
      setLoadState(result.code === 'setup_incomplete' ? 'setup_incomplete' : 'error');
      setLoadMessage(result.message);
    }
  }, []);

  /** Applies a rejected `iac.settings.get()` promise to state — the `.catch()` counterpart to {@link applyGetResult}. */
  const applyGetError = useCallback((err: unknown) => {
    if (!mountedRef.current) return;
    setLoadState('error');
    setLoadMessage(err instanceof Error ? err.message : 'Failed to load deployment settings.');
  }, []);

  // Initial load. No synchronous setState in the effect body itself — only
  // inside the `.then()`/`.catch()` callbacks below, which run as a later
  // microtask once the promise settles, not as part of the effect's own
  // synchronous execution.
  useEffect(() => {
    if (!hasSettingsBridge()) return;
    let cancelled = false;
    window.hyveon!.iac.settings
      .get()
      .then((result) => {
        if (!cancelled) applyGetResult(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) applyGetError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [applyGetResult, applyGetError]);

  /**
   * Re-fetches settings for the "Retry"/"Reload" actions. Setting
   * `loadState` to `'loading'` synchronously here is safe — this function is
   * only ever invoked from a `<Button onClick>` handler, never from inside
   * an effect body, so it isn't subject to `react-hooks/set-state-in-effect`.
   */
  const reload = useCallback(() => {
    if (!hasSettingsBridge()) {
      setLoadState('error');
      setLoadMessage('IPC bridge (window.hyveon) is not available in this context.');
      return;
    }
    setLoadState('loading');
    window.hyveon!.iac.settings.get().then(applyGetResult).catch(applyGetError);
  }, [applyGetResult, applyGetError]);

  /** Applies a partial patch to the draft, clearing any stale server-reported error state since the operator is actively editing. */
  const patchDraft = useCallback((patch: Partial<SettingsDraft>) => {
    setServerIssues(null);
    setSubmitError(null);
    setConflictMessage(null);
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const liveIssues = draft ? validateDeploymentSettingsPatch(draftToPatch(draft)) : [];
  const issues = serverIssues ?? liveIssues;
  const saveDisabled = !draft || issues.length > 0 || submitting;

  /**
   * Submits the draft via `iac.settings.update`, always forwarding `etag`
   * (the last-read version) as `expectedVersionId` — see the module doc's
   * "Optimistic locking" section for why this is unconditional rather than
   * opt-in. Routes every `DeploymentSettingsWriteResult` branch to its own
   * UI reaction; on any failure branch the draft is left untouched so the
   * operator doesn't lose their edits.
   *
   * Refuses to save outright when `etag` is falsy:
   * `DeploymentConfigService.putRawConfig()` omits the conditional-put `ifMatch` guard
   * entirely when `expectedVersionId` is falsy, turning the write into a
   * SILENT unconditional overwrite — exactly what optimistic locking exists
   * to prevent for this form. In practice `iac.settings.get()` always
   * returns an etag (every `RemoteFileStore` implementation sets one on
   * `get()`), so this path is defensive rather than expected to fire — but
   * degrading to an unconditional write silently would be worse than
   * refusing loudly.
   */
  const save = useCallback(async () => {
    if (!draft || !hasSettingsBridge()) return;
    if (!etag) {
      setSubmitError(
        'No version tag for the current settings — reload the page before saving, so a concurrent edit cannot be silently overwritten.',
      );
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setServerIssues(null);
    setConflictMessage(null);

    try {
      const patch = draftToPatch(draft);
      const result = await window.hyveon!.iac.settings.update({ patch, expectedVersionId: etag });
      if (!mountedRef.current) return;

      if (result.ok) {
        setEtag(result.etag);
        setDraft(draftFromSettings(result.settings));
        toast.success('Deployment settings saved');
        return;
      }

      switch (result.code) {
        case 'validation':
          setServerIssues(result.issues);
          break;
        case 'conflict':
          setConflictMessage(
            'This setting was changed elsewhere since you loaded this page — reload and try again.',
          );
          break;
        case 'setup_incomplete':
        case 'error':
          setSubmitError(result.message);
          break;
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setSubmitError(err instanceof Error ? err.message : 'Failed to save deployment settings.');
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [draft, etag]);

  return { draft, loadState, loadMessage, issues, submitting, submitError, conflictMessage, saveDisabled, patchDraft, save, reload };
}
