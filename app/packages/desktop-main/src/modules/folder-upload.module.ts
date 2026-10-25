import { Module } from '@nestjs/common';
import { AwsModule } from './aws.module.js';
import { DeploymentConfigModule } from './deployment-config.module.js';
import { ElectronStoreModule } from './electron-store.module.js';
import { FileBrowserClientFactory } from '../services/folderUpload/FileBrowserClient.js';
import { FolderScanService } from '../services/FolderScanService.js';
import { FolderUploadService } from '../services/FolderUploadService.js';

/** Folder-to-volume upload services: local scan, FileBrowser client factory, and the upload orchestrator. */
@Module({
  imports: [AwsModule, DeploymentConfigModule, ElectronStoreModule],
  providers: [FolderScanService, FileBrowserClientFactory, FolderUploadService],
  exports: [FolderScanService, FolderUploadService],
})
export class FolderUploadModule {}
