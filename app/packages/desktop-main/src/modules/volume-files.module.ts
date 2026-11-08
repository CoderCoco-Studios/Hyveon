import { Module } from '@nestjs/common';
import { AwsModule } from './aws.module.js';
import { FileBrowserClientFactory } from '../services/folderUpload/FileBrowserClient.js';
import { HelperSessionRegistry } from '../services/volumeFiles/HelperSessionRegistry.js';
import { UploadReservations } from '../services/volumeFiles/uploadReservations.js';

/** The shared file-manager helper session, the path reservations its writers share, and the FileBrowser client factory. */
@Module({
  imports: [AwsModule],
  providers: [FileBrowserClientFactory, HelperSessionRegistry, UploadReservations],
  exports: [FileBrowserClientFactory, HelperSessionRegistry, UploadReservations],
})
export class VolumeFilesModule {}
