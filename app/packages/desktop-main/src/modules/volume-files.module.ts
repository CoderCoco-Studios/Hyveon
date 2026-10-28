import { Module } from '@nestjs/common';
import { AwsModule } from './aws.module.js';
import { FileBrowserClientFactory } from '../services/folderUpload/FileBrowserClient.js';
import { HelperSessionRegistry } from '../services/volumeFiles/HelperSessionRegistry.js';

/** The shared file-manager helper session and the FileBrowser client factory that its consumers build backends with. */
@Module({
  imports: [AwsModule],
  providers: [FileBrowserClientFactory, HelperSessionRegistry],
  exports: [FileBrowserClientFactory, HelperSessionRegistry],
})
export class VolumeFilesModule {}
