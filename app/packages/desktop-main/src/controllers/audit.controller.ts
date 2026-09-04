import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { AuditPageResult } from '@hyveon/shared';
import { AuditService } from '../services/AuditService.js';
import type { ListAuditEntriesOpts } from '../services/AuditService.js';
import { logger } from '../logger.js';

/**
 * IPC-only controller exposing the `game_servers` mutation audit log for the
 * Electron main-process host. The single handler is bound to an IPC channel
 * via `@MessagePattern`. It delegates to the {@link AuditService} provider.
 */
@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * Returns a page of audit entries, newest-first — see
   * `AuditService.list()`. `opts` mirrors {@link ListAuditEntriesOpts}
   * (`limit`/`before`) and defaults to `{}` when the renderer invokes
   * `audit.list` with no arguments.
   *
   */
  @MessagePattern('audit.list')
  list(@Payload() opts: ListAuditEntriesOpts = {}): Promise<AuditPageResult> {
    logger.debug('AuditController: audit.list invoked');
    return this.audit.list(opts ?? {});
  }
}
