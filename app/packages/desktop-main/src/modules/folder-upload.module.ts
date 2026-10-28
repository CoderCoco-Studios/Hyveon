import { Module } from '@nestjs/common';
import { AwsModule } from './aws.module.js';
import { DeploymentConfigModule } from './deployment-config.module.js';
import { ElectronStoreModule } from './electron-store.module.js';
import { VolumeFilesModule } from './volume-files.module.js';
import { FolderScanService } from '../services/FolderScanService.js';
import { FolderUploadService } from '../services/FolderUploadService.js';

/** Folder-to-volume upload services: local scan and the upload orchestrator; the client factory comes from `VolumeFilesModule`. */
@Module({
  imports: [AwsModule, DeploymentConfigModule, ElectronStoreModule, VolumeFilesModule],
  providers: [FolderScanService, FolderUploadService],
  exports: [FolderScanService, FolderUploadService],
})
export class FolderUploadModule {}
