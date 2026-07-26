import { Module } from '@nestjs/common';
import { SafeStorageService } from '../services/SafeStorageService.js';
import { ElectronStoreService } from '../services/ElectronStoreService.js';

/**
 * Standalone module for `SafeStorageService` (OS-keychain encryption) and
 * `ElectronStoreService` (the typed electron-store consumer that depends on
 * it). Extracted — mirroring `ConfigModule` — so any feature module can
 * `imports: [ElectronStoreModule]` and receive both via Nest DI, rather than
 * depending on `AppModule` directly. `WizardModule` is the first consumer
 * (persisting wizard state and pasted AWS credentials).
 */
@Module({
  providers: [SafeStorageService, ElectronStoreService],
  exports: [SafeStorageService, ElectronStoreService],
})
export class ElectronStoreModule {}
