import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { ConfigService } from '../services/ConfigService.js';
import { logger } from '../logger.js';

/**
 * Environment metadata IPC controller. Returns deployment-level info (region, domain)
 * for UI display — e.g., the top bar env pill that shows "PROD · us-east-1".
 */
@Controller()
export class EnvController {
  constructor(private readonly config: ConfigService) {}

  /**
   * Returns environment context derived from the deployed stack's outputs.
   * The UI uses this to show the active region + environment label in the
   * top bar.
   */
  @MessagePattern('env.get')
  async getEnv(): Promise<{ region: string; domain: string; environment: string }> {
    logger.debug('EnvController: env.get invoked');
    const outputs = await this.config.getStackOutputs();
    const region = outputs?.awsRegion ?? 'local';
    const domain = outputs?.domainName ?? '';

    // Derive environment label from domain or fall back to 'local'
    // This is purely cosmetic for the UI — not a security gate
    const environment = domain ? 'PROD' : 'local';

    return { region, domain, environment };
  }
}
