/**
 * Minimum Terraform version the app supports, matching the `required_version`
 * constraint declared in both `terraform/main.tf` and
 * `terraform/aws/versions.tf`. Kept in `@hyveon/shared` (rather than
 * `@hyveon/desktop-main`) so the first-run wizard's prerequisite check and
 * Settings' "resolved vs. minimum" display can both import a single source
 * of truth.
 */
export const MINIMUM_TERRAFORM_VERSION = '1.5.0';
