/**
 * Pulumi engine version the desktop app provisions and runs against, matching
 * the `@pulumi/pulumi` dependency pinned in `app/packages/desktop-main/package.json`
 * and `app/packages/infra/package.json` (and asserted against the root
 * manifest by `app/test/packaging-manifest-pins.test.ts`). Kept in
 * `@hyveon/shared` (rather than `@hyveon/desktop-main`) so both
 * `PulumiEngineService`'s `PulumiCommand.install({ version: new SemVer(PULUMI_ENGINE_VERSION) })`
 * call and Settings' resolved-version display can import a single source of
 * truth, mirroring `MINIMUM_TERRAFORM_VERSION`'s split between
 * `@hyveon/shared` and its consumers.
 *
 * Unlike `MINIMUM_TERRAFORM_VERSION`, this is an exact pin, not a floor: the
 * app provisions exactly this version rather than "any version at least
 * this new" (see the "Pinned engine version" requirement in the
 * `pulumi-engine-runtime` delta spec), so the name says `PULUMI_ENGINE_VERSION`
 * rather than `MINIMUM_PULUMI_ENGINE_VERSION`.
 *
 * Bumping this value also requires bumping the `@pulumi/pulumi` dependency in
 * both `package.json` files above to the same version — `app/test/packaging-manifest-pins.test.ts`
 * asserts this constant equals the root manifest's `@pulumi/pulumi` pin, on
 * top of its existing cross-manifest dependency checks.
 */
export const PULUMI_ENGINE_VERSION = '3.255.0';
