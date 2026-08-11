## REMOVED Requirements

### Requirement: Binary detection service

**Reason**: Neither binary is a prerequisite any more. The `terraform` probe is obsolete because the app now provisions and caches its own infrastructure engine (see the `pulumi-engine-runtime` capability), so there is nothing on `PATH` to detect. The `aws` probe was always spurious — no code path in the app has ever invoked the AWS CLI; every AWS call goes through `@aws-sdk/*` clients — yet its result hard-blocked wizard progression.

**Migration**: Delete `PrerequisiteService` and its IPC channel. Callers that need to know whether infrastructure operations can run consult the engine-status surface defined by `pulumi-engine-runtime`'s "App-managed engine provisioning" requirement instead. `lookupCommandFor` is retained only if another consumer still needs it; otherwise it is removed with `TerraformService`.

### Requirement: Version parsing

**Reason**: There are no external tool versions left to parse. The infrastructure engine version is pinned by the app rather than discovered from a machine-local install, so there is no version string to scrape and no minimum-version comparison to perform against an operator-supplied binary.

**Migration**: The pinned engine version constant defined by `pulumi-engine-runtime`'s "Pinned engine version" requirement replaces `MINIMUM_TERRAFORM_VERSION` and the parsing helpers. Settings displays the resolved engine version from the engine service.

### Requirement: Prerequisite check IPC

**Reason**: The `wizard.prereqs.check` channel exists only to serve the two removed probes.

**Migration**: Remove the channel, its preload mirror `hyveon.wizard.checkPrereqs()`, and its `hyveon-api.ts` types. The wizard's readiness signal comes from the engine-status surface instead.

### Requirement: Install-prerequisites wizard step

**Reason**: The step's entire purpose is to block the operator until they have manually installed two binaries. With the engine app-managed and the AWS CLI unused, there is nothing for the operator to install, and the step would always pass.

**Migration**: Delete the step and its component. `wizard-flow`'s step list drops `prerequisites`, which also removes the special-casing that excluded it from the Settings "Reconfigure" flow.
