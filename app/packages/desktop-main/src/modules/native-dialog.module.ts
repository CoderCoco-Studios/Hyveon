import { Module } from '@nestjs/common';
import { NativeDialogService } from '../services/NativeDialogService.js';

/**
 * Standalone module for `NativeDialogService` (Electron open/save dialogs). Extracted so every dialog consumer —
 * folder scan, diagnostics export, volume-file transfers — imports it instead of owning a private copy.
 */
@Module({
  providers: [NativeDialogService],
  exports: [NativeDialogService],
})
export class NativeDialogModule {}
