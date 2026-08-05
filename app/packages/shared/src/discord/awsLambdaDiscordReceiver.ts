import type { DiscordEventReceiver } from '../cloud.js';

/**
 * Minimal subset of a {@link StackOutputs}-shaped object that this receiver
 * needs. Keeping this narrow avoids importing ConfigService or any
 * desktop-main package — `@hyveon/shared` must not depend on application
 * packages.
 */
export interface DiscordReceiverConfig {
  /** The public custom-domain URL for the Discord interactions endpoint
   *  (terraform output `discord_interactions_url`), or `null` / `undefined`
   *  when no endpoint has been deployed yet. */
  discord_interactions_url: string | null | undefined;
}

/**
 * AWS Lambda-backed implementation of {@link DiscordEventReceiver}.
 *
 * Resolves the Discord interactions endpoint URL from a pre-resolved
 * Terraform-outputs-shaped configuration object. No `@aws-sdk/*` imports
 * are needed — the URL is a plain string read directly from the config.
 *
 * @example
 * ```ts
 * const receiver = new AwsLambdaDiscordReceiver({
 *   discord_interactions_url: tfOutputs.discord_interactions_url,
 * });
 * const url = await receiver.getInteractionEndpointUrl();
 * ```
 */
export class AwsLambdaDiscordReceiver implements DiscordEventReceiver {
  private readonly url: string | null;

  /**
   * @param config - An object containing the `discord_interactions_url` field.
   *   Typically the parsed Terraform outputs for the current deployment.
   */
  constructor(config: DiscordReceiverConfig) {
    this.url = config.discord_interactions_url ?? null;
  }

  /**
   * Returns the fully-qualified HTTPS URL that Discord POSTs interaction
   * events to, or `null` if no endpoint has been provisioned yet.
   *
   * @returns A promise that resolves to the interactions endpoint URL string,
   *   or `null` when {@link DiscordReceiverConfig.discord_interactions_url}
   *   was absent or `null` at construction time.
   */
  async getInteractionEndpointUrl(): Promise<string | null> {
    return this.url;
  }
}
