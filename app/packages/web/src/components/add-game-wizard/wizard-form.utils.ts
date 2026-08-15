/**
 * Draft state shape + per-step validation for the add-game wizard (#99).
 *
 * The wizard walks the operator through six steps — identity, resources,
 * networking, storage, environment, review — that together assemble one
 * `game_servers` entry. Rather than re-implement the business rules already
 * enforced server-side, this module builds a proposed entry from the in-progress
 * {@link WizardDraft} and delegates to {@link validateGameServer} (the same
 * zod schema + business-rule validator used by `GamesWriteService`), then
 * buckets the returned issues back onto the step whose fields they belong
 * to via {@link stepForIssuePath}. This keeps the wizard's validation in
 * lockstep with the server without duplicating the rules.
 */

import {
  validateGameServer,
  validateHealthCheckAuthInput,
  checkConnectMessagePlaceholders,
  GAME_NAME_PATTERN,
  GAME_NAME_PATTERN_DESCRIPTION,
  type GameServerValidationIssue,
} from '@hyveon/shared/gameServerValidator';
import { ADD_GAME_WIZARD_STEPS, type AddGameWizardStep } from '@hyveon/shared';
import type {
  CreateGamePayload,
  GameServer,
  GameServerHealthCheck,
  GameServerHealthCheckCondition,
  GameServerHealthCheckAuthWriteInput,
  GameServerHealthCheckWriteInput,
  RedactedGameServer,
} from '../../api.service.js';

/**
 * Ordered steps of the add-game wizard, matching issue #99's scope.
 *
 * @remarks
 * Re-exported from `@hyveon/shared`'s {@link ADD_GAME_WIZARD_STEPS}, which is
 * also `GameWizardDraftService`'s source of truth for the valid `stepIndex`
 * range on a resumed draft — keep step additions/removals in that one file.
 */
export const WIZARD_STEPS = ADD_GAME_WIZARD_STEPS;

/** One step of the add-game wizard. */
export type WizardStep = AddGameWizardStep;

/**
 * Distinguishes the add wizard's create flow (where `name` is a brand-new,
 * fully-validated proposal) from the edit form's flow (where `name` is an
 * already-declared game's immutable key, rendered read-only — see
 * `EditGameForm`'s `nameDisabled` prop). {@link checkName} uses this to skip
 * name validation entirely in `'edit'` mode: re-running create-time
 * validation against an unchanged, already-declared name would incorrectly
 * reject legacy names that predate {@link GAME_NAME_PATTERN} (e.g. an
 * HCL-era name containing an underscore) even though nothing about the name
 * is being proposed to change. Every exported validation function here
 * defaults to `'create'` so existing add-wizard call sites are unaffected.
 */
export type WizardMode = 'create' | 'edit';

/** Placeholder name used to validate a draft before the operator has typed one, so the port-collision self-exclusion check never accidentally matches a real existing game. */
const DRAFT_NAME_PLACEHOLDER = '__draft__';

/** Draft form of a single `GameServerPort` row. `container` is `null` until the operator fills in the field, so an empty row can be told apart from a mistyped one. `visibility` is always a concrete `'public'`/`'internal'` value in the draft (never `undefined`) — a form control needs something to bind to; `draftToPayload` collapses `'public'` back to an omitted field on submit. */
export interface WizardDraftPort {
  container: number | null;
  protocol: string;
  visibility: 'public' | 'internal';
}

/** Draft form of a single `GameServerVolume` row. */
export interface WizardDraftVolume {
  name: string;
  container_path: string;
}

/** Draft form of a single `GameServerFileSeed` row. Empty strings mean "not set" and are stripped before validation/submit. */
export interface WizardDraftFileSeed {
  path: string;
  content: string;
  content_base64: string;
  mode: string;
}

/** Draft form of a single `GameServerEnvironmentVariable` row. */
export interface WizardDraftEnvironmentVariable {
  name: string;
  value: string;
}

/**
 * Draft form of the optional `healthCheck` declaration. `enabled` toggles
 * whether the game gets a `healthCheck` at all; every other field is only
 * meaningful when it's `true`. `authType` drives which credential fields are
 * shown/submitted: `'none'` (no credential), `'raw'` (operator-supplied
 * ARN, unchanged from before this field existed), `'basic'`
 * (username+password), `'bearer'` (token). For `'basic'`/`'bearer'`,
 * `username`/`password`/`token` are write-only — always blank on a resumed
 * or edit-mode draft; `secretSet` (from the redacted read-side shape) is
 * the only signal that a credential is already configured, regardless of
 * type. See {@link healthCheckFromDraft}'s doc for exactly how these fields
 * convert into the submitted `auth` write-input (including when a blank
 * `'none'` selection submits `null` vs. `undefined`).
 * `value` stores the declared comparison value as free text; it is parsed
 * to a JSON scalar (number/boolean/null/string) on submit, and is unused
 * (and not submitted) when `operator` is `"exists"`.
 */
export interface WizardDraftHealthCheck {
  enabled: boolean;
  scheme: string;
  port: number | null;
  path: string;
  method: string;
  timeoutMs: number | null;
  jsonPath: string;
  operator: string;
  value: string;
  authType: 'none' | 'raw' | 'basic' | 'bearer';
  secretArn: string;
  username: string;
  password: string;
  token: string;
  secretSet: boolean;
}

/** Blank {@link WizardDraftHealthCheck}, used both for a brand-new draft and for a declared game with no `healthCheck`. */
function emptyHealthCheckDraft(): WizardDraftHealthCheck {
  return {
    enabled: false,
    scheme: 'http',
    port: null,
    path: '',
    method: 'GET',
    timeoutMs: 2000,
    jsonPath: '',
    operator: 'equals',
    value: '',
    authType: 'none',
    secretArn: '',
    username: '',
    password: '',
    token: '',
    secretSet: false,
  };
}

/**
 * In-progress state of the add-game wizard, covering every field across all
 * six steps. Field names mirror `GameServer` (snake_case) since the draft
 * is converted directly into a proposed entry for {@link validateGameServer}.
 */
export interface WizardDraft {
  name: string;
  image: string;
  connect_message: string;
  cpu: number | null;
  memory: number | null;
  ports: WizardDraftPort[];
  volumes: WizardDraftVolume[];
  file_seeds: WizardDraftFileSeed[];
  environment: WizardDraftEnvironmentVariable[];
  https: boolean;
  healthCheck: WizardDraftHealthCheck;
}

/** Builds a blank {@link WizardDraft} — the wizard's initial state before the operator has entered anything. */
export function createEmptyWizardDraft(): WizardDraft {
  return {
    name: '',
    image: '',
    connect_message: '',
    cpu: null,
    memory: null,
    ports: [],
    volumes: [],
    file_seeds: [],
    environment: [],
    https: false,
    healthCheck: emptyHealthCheckDraft(),
  };
}

/**
 * Converts a declared {@link GameServer} entry into a {@link WizardDraft} —
 * the inverse of {@link draftToPayload}. Used to seed the wizard's edit flow
 * from an existing entry: optional fields (`connect_message`, `file_seeds`
 * and its per-row `content`/`content_base64`/`mode`) fall back to empty
 * strings since the draft's text inputs can't represent `undefined`.
 *
 * `https` is normalised with a strict `=== true` check rather than `?? false`:
 * `@cdktf/hcl2json` doesn't evaluate expressions, so a hand-written
 * `https = length(x) > 0 ? true : false` parses back as a *string*, which
 * `?? false` would let through as a truthy checkbox. Such an entry already
 * fails `z.boolean()` in `validateGameServer`, so the form can't represent it
 * either way — the strict check just makes the draft show `false` instead of
 * a value the checkbox can't actually mean.
 */
export function draftFromGameServer(game: RedactedGameServer): WizardDraft {
  return {
    name: game.name,
    image: game.image,
    connect_message: game.connect_message ?? '',
    cpu: game.cpu,
    memory: game.memory,
    ports: game.ports.map((port) => ({
      container: port.container,
      protocol: port.protocol,
      visibility: port.visibility === 'internal' ? 'internal' : 'public',
    })),
    volumes: game.volumes.map((volume) => ({ name: volume.name, container_path: volume.container_path })),
    file_seeds: (game.file_seeds ?? []).map((seed) => ({
      path: seed.path,
      content: seed.content ?? '',
      content_base64: seed.content_base64 ?? '',
      mode: seed.mode ?? '',
    })),
    environment: (game.environment ?? []).map((variable) => ({ name: variable.name, value: variable.value })),
    https: game.https === true,
    healthCheck: game.healthCheck
      ? {
          enabled: true,
          scheme: game.healthCheck.scheme,
          port: game.healthCheck.port,
          path: game.healthCheck.path,
          method: game.healthCheck.method,
          timeoutMs: game.healthCheck.timeoutMs,
          jsonPath: game.healthCheck.activeWhen.jsonPath,
          operator: game.healthCheck.activeWhen.operator,
          value: game.healthCheck.activeWhen.value === undefined ? '' : String(game.healthCheck.activeWhen.value),
          authType: game.healthCheck.secretSet ? 'raw' : 'none',
          secretArn: '',
          username: '',
          password: '',
          token: '',
          secretSet: game.healthCheck.secretSet,
        }
      : emptyHealthCheckDraft(),
  };
}

/** Parses a health-check comparison value's free-text form into the JSON scalar `validateGameServer` expects: `"true"`/`"false"`/`"null"` recognized as their literal, a numeric string as a number, anything else passed through as a string. */
function parseHealthCheckValue(raw: string): string | number | boolean | null {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw.trim().length > 0 && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/**
 * Converts a {@link WizardDraftHealthCheck} into the `healthCheck` field of
 * a proposed/submitted entry, or `undefined` when the operator hasn't
 * enabled one.
 *
 * `auth` follows the write-side convention `gamesWrite.ts` (`@hyveon/shared`)
 * declares: `undefined` leaves an existing credential unchanged (the
 * operator left every credential field blank on an edit), `null` explicitly
 * clears an existing credential (the operator selected `authType: 'none'`
 * on a draft that had `secretSet: true`), and a populated write-input object
 * sets/replaces it. `raw` submits a `type: 'raw'` object with `secretArn`
 * only when `secretArn` is non-blank; `basic` submits a `type: 'basic'`
 * object with `username`/`password` only when at least one of the two is
 * non-blank (so a half-filled edit still surfaces
 * {@link validateHealthCheckAuthInput}'s "both required" issue rather than
 * silently no-op'ing); `bearer` submits a `type: 'bearer'` object with
 * `token` only when `token` is non-blank.
 */
function healthCheckFromDraft(draft: WizardDraftHealthCheck): GameServerHealthCheckWriteInput | undefined {
  if (!draft.enabled) {
    return undefined;
  }

  const activeWhen: GameServerHealthCheckCondition =
    draft.operator === 'exists'
      ? { jsonPath: draft.jsonPath, operator: 'exists' }
      : {
          jsonPath: draft.jsonPath,
          operator: draft.operator as GameServerHealthCheckCondition['operator'],
          value: parseHealthCheckValue(draft.value),
        };

  const base = {
    kind: 'http' as const,
    scheme: draft.scheme as GameServerHealthCheck['scheme'],
    port: draft.port ?? 0,
    path: draft.path,
    method: draft.method as GameServerHealthCheck['method'],
    timeoutMs: draft.timeoutMs ?? 0,
    activeWhen,
  };

  const auth = healthCheckAuthInputFromDraft(draft);
  return auth === undefined ? base : { ...base, auth };
}

/** Builds the `auth` write-input `healthCheckFromDraft` submits — see that function's doc for the `undefined`/`null`/object convention. */
function healthCheckAuthInputFromDraft(draft: WizardDraftHealthCheck): GameServerHealthCheckAuthWriteInput | null | undefined {
  switch (draft.authType) {
    case 'none':
      return draft.secretSet ? null : undefined;
    case 'raw':
      return draft.secretArn.trim().length > 0 ? { type: 'raw', secretArn: draft.secretArn.trim() } : undefined;
    case 'basic':
      return draft.username.trim().length > 0 || draft.password.trim().length > 0
        ? { type: 'basic', username: draft.username.trim(), password: draft.password.trim() }
        : undefined;
    case 'bearer':
      return draft.token.trim().length > 0 ? { type: 'bearer', token: draft.token.trim() } : undefined;
  }
}

/**
 * Converts a completed {@link WizardDraft} into the `POST /api/games`
 * (`games.create` IPC) payload — the inverse of {@link draftFromGameServer}.
 * Only called once the Review step's "Submit" button is enabled, which
 * requires {@link validateStep} to report zero issues for `review` — so
 * `cpu`/`memory`/port `container` values are guaranteed non-null at this
 * point; the `?? 0` fallbacks only guard the type checker, they're never
 * expected to fire in practice.
 */
export function draftToPayload(draft: WizardDraft): CreateGamePayload {
  const name = draft.name.trim();
  const connectMessage = draft.connect_message.trim();
  const image = draft.image.trim();

  return {
    name,
    config: {
      image,
      cpu: draft.cpu ?? 0,
      memory: draft.memory ?? 0,
      ports: draft.ports.map((port) => ({
        container: port.container ?? 0,
        protocol: port.protocol,
        ...(port.visibility === 'internal' ? { visibility: 'internal' as const } : {}),
      })),
      volumes: draft.volumes.map((volume) => ({ name: volume.name, container_path: volume.container_path })),
      connect_message: connectMessage.length > 0 ? connectMessage : undefined,
      file_seeds:
        draft.file_seeds.length > 0
          ? draft.file_seeds.map((seed) => ({
              path: seed.path,
              content: seed.content.length > 0 ? seed.content : undefined,
              content_base64: seed.content_base64.length > 0 ? seed.content_base64 : undefined,
              mode: seed.mode.length > 0 ? seed.mode : undefined,
            }))
          : undefined,
      environment: draft.environment.length > 0 ? draft.environment.map((v) => ({ name: v.name, value: v.value })) : undefined,
      https: draft.https,
      healthCheck: healthCheckFromDraft(draft.healthCheck),
    },
  };
}

/**
 * Maps a validation issue's `path` (e.g. `volumes[0].container_path`,
 * `ports[1]`, `memory`, `name`) to the wizard step whose fields own it, by
 * looking at the first path segment (the field family). Every top-level
 * field on {@link WizardDraft} is covered: `name`/`image`/`connect_message`
 * → identity, `cpu`/`memory` → resources, `ports` → networking,
 * `volumes`/`file_seeds` → storage, `environment` → environment. Anything
 * unrecognized falls back to `review` so it's still surfaced somewhere
 * rather than silently dropped.
 */
export function stepForIssuePath(path: string): WizardStep {
  const family = path.split(/[.[]/)[0];
  switch (family) {
    case 'name':
    case 'image':
    case 'connect_message':
      return 'identity';
    case 'cpu':
    case 'memory':
      return 'resources';
    case 'ports':
    case 'healthCheck':
      return 'networking';
    case 'volumes':
    case 'file_seeds':
      return 'storage';
    case 'environment':
      return 'environment';
    default:
      return 'review';
  }
}

/**
 * Validates `name` against the rules `DeploymentConfigService.insertGameServerEntry()`
 * enforces server-side: non-empty, matches the shared
 * {@link GAME_NAME_PATTERN} (DNS-label-safe, imported from
 * `@hyveon/shared/gameServerValidator` so this can never drift from the
 * server-side rule the way it once did), and not already used by another
 * declared game. This lives outside {@link validateGameServer} because that
 * function treats `name` purely as the map key for self-exclusion in the
 * port-collision check, not as a field to validate in its own right.
 *
 * In `'edit'` {@link mode}, returns no issues at all — see {@link WizardMode}'s
 * doc for why an already-declared game's immutable name must never be
 * re-validated against create-time rules.
 */
function checkName(name: string, existingGames: GameServer[], mode: WizardMode): GameServerValidationIssue[] {
  if (mode === 'edit') {
    return [];
  }

  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return [{ path: 'name', message: 'Name is required.' }];
  }

  const issues: GameServerValidationIssue[] = [];

  if (!GAME_NAME_PATTERN.test(trimmed)) {
    issues.push({
      path: 'name',
      message: `Name must be ${GAME_NAME_PATTERN_DESCRIPTION}.`,
    });
  }

  if (existingGames.some((game) => game.name === trimmed)) {
    issues.push({ path: 'name', message: `A game named "${trimmed}" already exists.` });
  }

  return issues;
}

/** Converts a {@link WizardDraft} into the plain-object shape {@link validateGameServer} expects for its `proposed` parameter, stripping unset optional fields so they don't trip type checks with empty strings. */
function toProposedEntry(draft: WizardDraft): Record<string, unknown> {
  return {
    image: draft.image.trim(),
    cpu: draft.cpu,
    memory: draft.memory,
    ports: draft.ports.map((port) => ({
      container: port.container,
      protocol: port.protocol,
      ...(port.visibility === 'internal' ? { visibility: 'internal' as const } : {}),
    })),
    volumes: draft.volumes.map((volume) => ({ name: volume.name, container_path: volume.container_path })),
    connect_message: draft.connect_message.trim().length > 0 ? draft.connect_message : undefined,
    file_seeds:
      draft.file_seeds.length > 0
        ? draft.file_seeds.map((seed) => ({
            path: seed.path,
            content: seed.content.length > 0 ? seed.content : undefined,
            content_base64: seed.content_base64.length > 0 ? seed.content_base64 : undefined,
            mode: seed.mode.length > 0 ? seed.mode : undefined,
          }))
        : undefined,
    environment:
      draft.environment.length > 0 ? draft.environment.map((v) => ({ name: v.name, value: v.value })) : undefined,
    https: draft.https,
    healthCheck: toStructuralHealthCheckPreview(draft.healthCheck),
  };
}

/**
 * Builds the `healthCheck` object passed to `validateGameServer` for the
 * wizard's own client-side gating (`toProposedEntry`) — NOT the submitted
 * payload (`draftToPayload` uses {@link healthCheckFromDraft} directly).
 * `validateGameServer`'s persisted-shape schema always requires `secretArn`
 * on a declared `auth`; for `basic`/`bearer` that ARN doesn't exist yet
 * client-side (the app only creates it on submit), so `auth` is stripped
 * from this preview object for those two types. The per-type plaintext
 * requirement itself is still enforced — via
 * {@link validateHealthCheckAuthInput}, called separately by
 * {@link validateWizardDraft} — so nothing is silently skipped, only the
 * ARN-shape check that can't apply yet.
 */
function toStructuralHealthCheckPreview(draft: WizardDraftHealthCheck): GameServerHealthCheck | undefined {
  const withAuth = healthCheckFromDraft(draft);
  if (!withAuth) {
    return undefined;
  }
  if (withAuth.auth === undefined || withAuth.auth?.type === 'raw') {
    return withAuth as GameServerHealthCheck;
  }
  const { auth: _auth, ...rest } = withAuth;
  return rest as GameServerHealthCheck;
}

/**
 * Validates `image` isn't blank. The shared `gameServerSchema` types `image`
 * as a plain `z.string()` with no minimum length (an empty string is a valid
 * server-side value structurally), but a blank image reference is never
 * usable, so the wizard enforces non-emptiness itself.
 */
function checkImage(image: string): GameServerValidationIssue[] {
  if (image.trim().length === 0) {
    return [{ path: 'image', message: 'Image is required.' }];
  }
  return [];
}

/**
 * Validates the entire draft: `name` (via {@link checkName}), `image` (via
 * {@link checkImage}), `connect_message` placeholders (via the shared
 * {@link checkConnectMessagePlaceholders}, imported from
 * `@hyveon/shared/gameServerValidator` and run unconditionally here) plus
 * every structural/business rule {@link validateGameServer} enforces
 * (Fargate cpu/memory pairing, absolute volume/file_seed paths, its own
 * internal call to the same connect_message placeholder check, and port
 * collisions — both within the draft's own `ports` list and against
 * `existingGames`). Returns every issue found, unfiltered by step, deduped
 * by `path`+`message` — this only matters because `validateGameServer`'s
 * failure result isn't limited to structural parse failures: a structurally
 * complete draft can still fail on a pure business-rule violation, and in
 * that case `validateGameServer`'s own connect_message placeholder check
 * already ran, so appending our own call unconditionally on
 * `!result.success` would otherwise double up identical issues.
 *
 * @param mode - `'create'` (default) validates `name` in full; `'edit'`
 *   skips name validation entirely — see {@link WizardMode}'s doc.
 */
export function validateWizardDraft(
  draft: WizardDraft,
  existingGames: GameServer[],
  mode: WizardMode = 'create',
): GameServerValidationIssue[] {
  const issues = [...checkName(draft.name, existingGames, mode), ...checkImage(draft.image)];

  if (draft.healthCheck.enabled) {
    issues.push(...validateHealthCheckAuthInput(healthCheckAuthInputFromDraft(draft.healthCheck) ?? undefined));
  }

  const name = draft.name.trim().length > 0 ? draft.name.trim() : DRAFT_NAME_PLACEHOLDER;
  const result = validateGameServer(name, toProposedEntry(draft), existingGames);
  if (!result.success) {
    issues.push(...result.issues);
    // validateGameServer only runs its own connect_message placeholder check
    // once the full entry parses structurally, so a structural failure here
    // (e.g. cpu/memory still null) means that check may never have run. Run
    // the same shared check so an invalid placeholder is still caught on the
    // Identity step; duplicates against an already-run copy are removed below.
    issues.push(...checkConnectMessagePlaceholders(draft.connect_message));
  }

  return dedupeIssues(issues);
}

/**
 * Removes duplicate issues (same `path` and `message`) while preserving
 * first-seen order. Needed because {@link validateWizardDraft} can surface
 * the same `connect_message` placeholder issue twice: once from
 * `validateGameServer`'s own internal call to the shared
 * {@link checkConnectMessagePlaceholders} (when the structural parse
 * succeeded) and once from the unconditional call above (run on any
 * failure, structural or not).
 */
function dedupeIssues(issues: GameServerValidationIssue[]): GameServerValidationIssue[] {
  const seen = new Set<string>();
  const deduped: GameServerValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.path} ${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(issue);
    }
  }
  return deduped;
}

/**
 * Validates the draft and filters the result down to issues belonging to
 * `step` (via {@link stepForIssuePath}), so a step component only sees — and
 * only blocks advancement on — errors in its own fields.
 *
 * @param mode - Forwarded to {@link validateWizardDraft} — `'create'`
 *   (default) for the add wizard, `'edit'` for `EditGameForm`'s
 *   `validateStep('review', ...)` call, whose `name` field is read-only.
 */
export function validateStep(
  step: WizardStep,
  draft: WizardDraft,
  existingGames: GameServer[],
  mode: WizardMode = 'create',
): GameServerValidationIssue[] {
  if (step === 'review') {
    return validateWizardDraft(draft, existingGames, mode);
  }
  return validateWizardDraft(draft, existingGames, mode).filter((issue) => stepForIssuePath(issue.path) === step);
}

/** Convenience wrapper: `true` when `step` has no outstanding validation issues, so the wizard can gate its "Next" button. */
export function canAdvance(
  step: WizardStep,
  draft: WizardDraft,
  existingGames: GameServer[],
  mode: WizardMode = 'create',
): boolean {
  return validateStep(step, draft, existingGames, mode).length === 0;
}

/** Validates the "Identity" step: `name`, `image`, `connect_message`. */
export function validateIdentityStep(
  draft: WizardDraft,
  existingGames: GameServer[],
  mode: WizardMode = 'create',
): GameServerValidationIssue[] {
  return validateStep('identity', draft, existingGames, mode);
}

/** Validates the "Resources" step: `cpu`/`memory`, including the Fargate cpu/memory pairing rule. */
export function validateResourcesStep(
  draft: WizardDraft,
  existingGames: GameServer[],
  mode: WizardMode = 'create',
): GameServerValidationIssue[] {
  return validateStep('resources', draft, existingGames, mode);
}

/** Validates the "Networking" step: `ports`, including collisions within the draft and against `existingGames`. */
export function validateNetworkingStep(
  draft: WizardDraft,
  existingGames: GameServer[],
  mode: WizardMode = 'create',
): GameServerValidationIssue[] {
  return validateStep('networking', draft, existingGames, mode);
}

/** Validates the "Storage" step: `volumes` (including the at-least-one-volume rule) and `file_seeds`. */
export function validateStorageStep(
  draft: WizardDraft,
  existingGames: GameServer[],
  mode: WizardMode = 'create',
): GameServerValidationIssue[] {
  return validateStep('storage', draft, existingGames, mode);
}

/** Validates the "Environment" step: `environment` row names (non-empty, no duplicates within the entry). */
export function validateEnvironmentStep(
  draft: WizardDraft,
  existingGames: GameServer[],
  mode: WizardMode = 'create',
): GameServerValidationIssue[] {
  return validateStep('environment', draft, existingGames, mode);
}

/** Validates the "Review" step: every issue across the whole draft, since review is the final gate before submit. */
export function validateReviewStep(
  draft: WizardDraft,
  existingGames: GameServer[],
  mode: WizardMode = 'create',
): GameServerValidationIssue[] {
  return validateStep('review', draft, existingGames, mode);
}

/** Finds the message (if any) whose issue path is exactly `path`. Shared by step components that render per-row/per-field validation errors. */
export function messageFor(issues: GameServerValidationIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}
