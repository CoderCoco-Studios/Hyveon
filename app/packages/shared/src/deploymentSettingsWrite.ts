/**
 * Request/result payload shapes plus the shared client+server validator for
 * the `iac.settings.get` / `iac.settings.update` IPC channels — the
 * deployment-settings editor for every top-level
 * {@link TopLevelDeploymentSettings} field (everything in
 * {@link DeploymentConfig} except `gameServers`, which keeps its own
 * dedicated `gamesWrite.ts` surface).
 *
 * Mirrors `gamesWrite.ts`'s shape deliberately: a discriminated
 * `ok`/`code` result union for the write path, and a `path`/`message`
 * validation-issue shape mirroring {@link GameServerValidationIssue}'s —
 * both so `@hyveon/web`'s settings form can reuse the exact
 * live-client-validation-plus-server-rejection UX the add-game-wizard/
 * edit-game-form pattern already established (see `wizard-form.utils.ts`),
 * not a bespoke shape invented for this one form.
 */

import type { TopLevelDeploymentSettings } from './deploymentConfig.js';

/**
 * A single structural or business-rule validation failure for a proposed
 * {@link TopLevelDeploymentSettings} patch, positioned by field name (e.g.
 * `hostedZoneName`, `baseAllowedGuilds[1]`) so the form can highlight the
 * offending field. Shape mirrors `GameServerValidationIssue`
 * (`gameServerValidator.ts`) deliberately — not reused directly, since that
 * type's own name and doc comment are scoped to `gameServers` entries, and
 * this module's issues are never mixed into the same list.
 */
export interface DeploymentSettingsValidationIssue {
  path: string;
  message: string;
}

/**
 * Validates a proposed {@link TopLevelDeploymentSettings} patch — the single source of truth for
 * both `@hyveon/web`'s live, before-submit form validation and `IacSettingsController.update`
 * (`@hyveon/desktop-main`)'s final server-side gate before writing.
 *
 * This validates a PATCH, not a full document: only fields actually present on `patch` are
 * checked, so an omitted field ("leave the current value alone") is never flagged. Every check
 * validates a present field's TYPE first and rejects immediately if it's wrong — e.g.
 * `{ hostedZoneName: 42 }` is rejected rather than silently written into `deployment-config.json`
 * — so a caller that bypasses the renderer (a modified client, a hand-crafted IPC payload) can't
 * corrupt downstream consumers that assume the declared `TopLevelDeploymentSettings` types.
 *
 * @param patch - The proposed partial update.
 * @returns Every issue found; empty when `patch` is structurally valid.
 */
export function validateDeploymentSettingsPatch(
  patch: Partial<TopLevelDeploymentSettings>,
): DeploymentSettingsValidationIssue[] {
  const issues: DeploymentSettingsValidationIssue[] = [];

  checkStringField(patch, 'hostedZoneName', issues, { requireNonEmpty: true });
  checkStringField(patch, 'projectName', issues, { requireNonEmpty: true });
  checkStringField(patch, 'awsRegion', issues, { requireNonEmpty: true });
  checkStringField(patch, 'discordApplicationId', issues, { requireNonEmpty: false });
  checkStringField(patch, 'auditTableName', issues, { requireNonEmpty: false });
  checkStringField(patch, 'runsTableName', issues, { requireNonEmpty: false });

  if (patch.vpcCidr !== undefined) {
    if (typeof patch.vpcCidr !== 'string') {
      issues.push({ path: 'vpcCidr', message: 'Must be a string.' });
    } else if (!CIDR_PATTERN.test(patch.vpcCidr.trim())) {
      issues.push({ path: 'vpcCidr', message: 'Must be a valid IPv4 CIDR block, e.g. "10.0.0.0/16".' });
    }
  }

  checkPositiveInteger(patch, 'dnsTtl', issues);
  checkPositiveInteger(patch, 'watchdogIntervalMinutes', issues);
  checkPositiveInteger(patch, 'watchdogIdleChecks', issues);
  checkPositiveInteger(patch, 'watchdogMinPackets', issues);

  checkSnowflakeArray(patch, 'baseAllowedGuilds', issues);
  checkSnowflakeArray(patch, 'baseAdminUserIds', issues);
  checkSnowflakeArray(patch, 'baseAdminRoleIds', issues);

  return issues;
}

/** Matches a 17-20 digit Discord snowflake ID. Single shared copy — also used by `@hyveon/web`'s `isSnowflake`. */
export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/** Validates a Discord snowflake ID (17-20 digit numeric string). */
export function isSnowflake(value: string): boolean {
  return SNOWFLAKE_PATTERN.test(value.trim());
}

/**
 * Matches an IPv4 CIDR block: four dot-separated 0-255 octets, a `/`, and a
 * 0-32 prefix length. Deliberately simple (no IPv6 support — `vpcCidr`'s own
 * TSDoc and default in `DEPLOYMENT_CONFIG_DEFAULTS` are both
 * IPv4-only) and not exhaustive about
 * every malformed edge case (e.g. `010.0.0.0/16` with a leading zero passes)
 * — "prevent obviously malformed input", not a full IP-address validator.
 */
const CIDR_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}\/(3[0-2]|[12]?\d)$/;

/**
 * Pushes an issue for `field` when present on `patch` and either not a
 * string at all, or (when `opts.requireNonEmpty`) blank/whitespace-only.
 * Type-checks even the three "never validated for emptiness" fields
 * (`discordApplicationId`/`auditTableName`/`runsTableName`,
 * `requireNonEmpty: false`) — a wrong JS type is rejected regardless of
 * whether emptiness itself is enforced. See
 * {@link validateDeploymentSettingsPatch}'s "Type safety" doc for why a
 * present-but-wrong-typed value is never silently skipped.
 */
function checkStringField<K extends keyof TopLevelDeploymentSettings>(
  patch: Partial<TopLevelDeploymentSettings>,
  field: K,
  issues: DeploymentSettingsValidationIssue[],
  opts: { requireNonEmpty: boolean },
): void {
  const value = patch[field];
  if (value === undefined) return;
  if (typeof value !== 'string') {
    issues.push({ path: field, message: 'Must be a string.' });
    return;
  }
  if (opts.requireNonEmpty && value.trim().length === 0) {
    issues.push({ path: field, message: 'Must not be empty.' });
  }
}

/** Pushes an issue for `field` when present on `patch` and not a positive (\> 0) integer. */
function checkPositiveInteger<K extends keyof TopLevelDeploymentSettings>(
  patch: Partial<TopLevelDeploymentSettings>,
  field: K,
  issues: DeploymentSettingsValidationIssue[],
): void {
  const value = patch[field];
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    issues.push({ path: field, message: 'Must be a positive whole number.' });
  }
}

/**
 * Pushes an issue for `field` when present on `patch` and not an array at
 * all, otherwise one issue per non-snowflake-shaped entry, positioned by
 * array index (e.g. `baseAllowedGuilds[1]`). A non-array value (a string, a
 * number, an object) is rejected outright rather than silently skipped —
 * see {@link validateDeploymentSettingsPatch}'s "Type safety" doc.
 */
function checkSnowflakeArray<K extends keyof TopLevelDeploymentSettings>(
  patch: Partial<TopLevelDeploymentSettings>,
  field: K,
  issues: DeploymentSettingsValidationIssue[],
): void {
  const value = patch[field];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path: field, message: 'Must be an array of Discord snowflake IDs.' });
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !isSnowflake(entry)) {
      issues.push({ path: `${field}[${index}]`, message: 'Must be a 17-20 digit Discord snowflake ID.' });
    }
  });
}

/**
 * Successful read of the top-level settings — the `iac.settings.get`
 * result shape. `etag` is the `RemoteFileStore` etag to round-trip as
 * `expectedVersionId` on the follow-up `iac.settings.update` call, mirroring
 * `DeploymentConfigService.getRawConfig()`'s own `{ config, etag }` shape.
 */
export interface DeploymentSettingsGetSuccess {
  ok: true;
  settings: TopLevelDeploymentSettings;
  etag?: string;
}

/**
 * No configuration bucket is configured — the operator has not finished (or
 * has somehow un-finished) the First-Run Wizard's bootstrap step. Mirrors
 * `GameWriteSetupIncomplete` (`gamesWrite.ts`) — see that type's own doc
 * comment for the full rationale.
 */
export interface DeploymentSettingsSetupIncomplete {
  ok: false;
  code: 'setup_incomplete';
  message: string;
}

/** Catch-all failure for errors that aren't validation/conflict/setup-incomplete (e.g. an unexpected S3 error or malformed config JSON). */
export interface DeploymentSettingsFailure {
  ok: false;
  code: 'error';
  message: string;
}

/** Discriminated union returned by the `iac.settings.get` handler. Discriminate on `ok` first, then `code` for the failure branches. */
export type DeploymentSettingsGetResult =
  | DeploymentSettingsGetSuccess
  | DeploymentSettingsSetupIncomplete
  | DeploymentSettingsFailure;

/**
 * Successful write — the freshly-written settings (re-read post-write, so
 * every value reflects exactly what's now persisted, including any field
 * the caller's `patch` omitted) plus the write's new `etag`/`versionId` for
 * a subsequent edit's `expectedVersionId`.
 */
export interface DeploymentSettingsWriteSuccess {
  ok: true;
  settings: TopLevelDeploymentSettings;
  etag: string;
  versionId?: string;
}

/**
 * The write was rejected because the caller's `expectedVersionId` didn't
 * match the current deployment-config object version — someone else edited
 * the configuration since the caller last read it. Mirrors `GameWriteConflict`
 * (`gamesWrite.ts`) — `currentVersionId` lets the caller re-fetch and retry.
 */
export interface DeploymentSettingsConflict {
  ok: false;
  code: 'conflict';
  expectedVersionId?: string;
  currentVersionId?: string;
  message: string;
}

/** The proposed patch failed {@link validateDeploymentSettingsPatch}. */
export interface DeploymentSettingsValidationFailure {
  ok: false;
  code: 'validation';
  issues: DeploymentSettingsValidationIssue[];
}

/** Discriminated union returned by the `iac.settings.update` handler. Discriminate on `ok` first, then `code` for the failure branches. */
export type DeploymentSettingsWriteResult =
  | DeploymentSettingsWriteSuccess
  | DeploymentSettingsConflict
  | DeploymentSettingsValidationFailure
  | DeploymentSettingsSetupIncomplete
  | DeploymentSettingsFailure;

/**
 * Request payload for `iac.settings.update`. `patch` is merged onto every
 * top-level field except `gameServers` (which is never reachable through
 * this type at all — see {@link TopLevelDeploymentSettings}'s own doc
 * comment); an omitted field keeps its current stored value.
 * `expectedVersionId`, when supplied, is checked against the current
 * deployment-config object version and a {@link DeploymentSettingsConflict}
 * is returned on mismatch. The renderer always supplies it — it's optional
 * here only because `DeploymentConfigService.updateTopLevelSettings`'s own
 * unconditional-write convention (mirroring `addGameServer`/
 * `updateGameServer`) requires the parameter to stay optional at the type
 * level.
 */
export interface UpdateDeploymentSettingsPayload {
  patch: Partial<TopLevelDeploymentSettings>;
  expectedVersionId?: string;
}
