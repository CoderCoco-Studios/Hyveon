/**
 * Pulumi engine version the desktop app provisions and runs against, matching
 * the `@pulumi/pulumi` dependency pinned in `app/packages/desktop-main/package.json`
 * and `app/packages/infra/package.json` (and asserted against the root
 * manifest by `app/test/packaging-manifest-pins.test.ts`). Kept in
 * `@hyveon/shared` (rather than `@hyveon/desktop-main`) so both
 * `PulumiEngineService`'s `PulumiCommand.install({ version: new SemVer(PULUMI_ENGINE_VERSION) })`
 * call and Settings' resolved-version display can import a single source of
 * truth.
 *
 * This is an exact pin, not a floor: the app provisions exactly this version
 * rather than "any version at least this new" (see the "Pinned engine
 * version" requirement in the `pulumi-engine-runtime` delta spec), so the
 * name says `PULUMI_ENGINE_VERSION` rather than `MINIMUM_PULUMI_ENGINE_VERSION`.
 *
 * Bumping this value also requires bumping the `@pulumi/pulumi` dependency in
 * both `package.json` files above to the same version — `app/test/packaging-manifest-pins.test.ts`
 * asserts this constant equals the root manifest's `@pulumi/pulumi` pin, on
 * top of its existing cross-manifest dependency checks.
 */
export const PULUMI_ENGINE_VERSION = '3.255.0';

/**
 * Result shape for the `iac.settings.engineVersion` IPC channel — Settings'
 * Cloud Setup version row reads this to pair the resolved engine version
 * with {@link PULUMI_ENGINE_VERSION}.
 * `resolvedVersion` mirrors `PulumiEngineService.getResolvedVersion()`'s own
 * return type verbatim: `null` means the engine has not been provisioned yet
 * (including while a first resolution is still in flight) — a real, expected
 * state for a fresh install, never a failure — never a rejected promise on
 * this channel, since the underlying getter is a synchronous field read that
 * cannot throw.
 */
export interface PulumiEngineVersionResult {
  resolvedVersion: string | null;
}
