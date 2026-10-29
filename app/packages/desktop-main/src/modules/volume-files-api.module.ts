import { Module } from '@nestjs/common';
import { AwsModule } from './aws.module.js';
import { DeploymentConfigModule } from './deployment-config.module.js';
import { FolderUploadModule } from './folder-upload.module.js';
import { NativeDialogModule } from './native-dialog.module.js';
import { VolumeFilesModule } from './volume-files.module.js';
import { VolumeFilesService } from '../services/volumeFiles/VolumeFilesService.js';

/**
 * The operator-facing file-browser service behind the `volumeFiles.*` IPC channels.
 *
 * @remarks
 * Separate from `VolumeFilesModule` because `FolderUploadModule` already imports that module, and the service needs
 * folder-upload providers for folder uploads.
 */
@Module({
  imports: [AwsModule, DeploymentConfigModule, VolumeFilesModule, FolderUploadModule, NativeDialogModule],
  providers: [VolumeFilesService],
  exports: [VolumeFilesService],
})
export class VolumeFilesApiModule {}
