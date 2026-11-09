import { Module } from '@nestjs/common';
import { ShellRevealService } from '../services/ShellRevealService.js';

/** Provides `ShellRevealService` so every owner of a revealable file records into one shared instance. */
@Module({
  providers: [ShellRevealService],
  exports: [ShellRevealService],
})
// @spec APP-SHELL-REVEAL-001
export class ShellModule {}
