import { Module } from '@nestjs/common';
import { AwsModule } from './aws.module.js';
import { DiscordConfigService } from '../services/DiscordConfigService.js';
import { DiscordCommandRegistrar } from '../services/DiscordCommandRegistrar.js';

/**
 * Discord configuration module.
 *
 * No discord.js client here — the bot lives entirely in the
 * interactions/followup Lambdas (`InteractionsLambda` and `FollowupLambda`).
 * The Nest server only needs to:
 *  - Persist DiscordConfig to DynamoDB and bot credentials to Secrets Manager
 *    (`DiscordConfigService`).
 *  - PUT slash commands into a guild via Discord's REST API when the operator
 *    clicks "Register commands" (`DiscordCommandRegistrar`).
 *
 * `AwsModule` re-exports `CloudProviderModule`, which is where
 * `DiscordConfigService`'s `SECRETS_STORE`/`DISCORD_CONFIG_STORE` tokens are
 * bound — no separate `ElectronStoreModule` import needed here since neither
 * dependency touches `ElectronStoreService` directly.
 */
@Module({
  imports: [AwsModule],
  providers: [DiscordConfigService, DiscordCommandRegistrar],
  exports: [DiscordConfigService, DiscordCommandRegistrar],
})
export class DiscordModule {}
