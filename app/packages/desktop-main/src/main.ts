import 'reflect-metadata';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestMicroservice } from '@nestjs/common';
import { MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module.js';
import { applyFixPath } from './fix-path-bootstrap.js';
import { BridgedElectronIPCTransport, registerIpcMainBridges } from './ipc-main-bridge.js';
import { createLogger } from './logger.js';
import { RpcErrorMessageFilter } from './rpc-error-message.filter.js';

applyFixPath();

// ElectronIPCTransport requires ipcMain, which is only available inside an
// Electron main process. Fail fast with a readable message rather than a
// cryptic module-resolution error when someone runs `node dist/main.js`.
// This guard must run before any Electron API calls (e.g. app.getPath).
if (!process.versions['electron']) {
  throw new Error(
    'desktop-main must run inside an Electron main process. ' +
      'Launch via Electron — running with plain Node is not supported.',
  );
}

const { app } = await import('electron') as unknown as { app: { getPath(name: string): string } };
createLogger(path.join(app.getPath('userData'), 'logs'));

/**
 * Bootstraps the NestJS IPC microservice.
 *
 * Called from `electron-entry.ts` after `app.whenReady()` so that
 * `ipcMain` is available before the transport is initialised. Returns the
 * Nest application context so `electron-entry.ts` can resolve providers
 * (e.g. `ElectronStoreService` for `initUpdater`) from the same DI graph the
 * IPC controllers use, rather than constructing a second instance.
 *
 * @remarks
 * Global filters must be registered before `app.listen()`, since NestJS reads
 * them while wiring up each `@MessagePattern` handler during listen(); after
 * `app.listen()` starts the transport, {@link registerIpcMainBridges} bridges
 * each registered pattern onto a real `ipcMain.handle` call.
 */
export async function bootstrap(): Promise<INestMicroservice> {
  const strategy = new BridgedElectronIPCTransport();
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    strategy,
  });

  app.useGlobalFilters(new RpcErrorMessageFilter());

  await app.listen();

  await registerIpcMainBridges(strategy);

  return app;
}
