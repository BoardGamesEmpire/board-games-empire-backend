import { DatabaseModule } from '@bge/database';
import { ServicesModule } from '@bge/services';
import { StorageMisconfiguredError, type StorageDriver } from '@boardgamesempire/storage-contract';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalDiskDriver } from './local-disk.driver.js';
import { MediaUrlSigner } from './media-url-signer.js';
import type { MediaConfig } from './media.config.js';
import { SigningKeyService } from './signing-key.service.js';
import { StorageService } from './storage.service.js';
import { STORAGE_DRIVER } from './storage.tokens.js';

/**
 * Wires the storage runtime. The active driver is resolved from `media.driver`
 * config (v1: 'localdisk' only; a registry lands with the plugin loader, #59).
 * Requires `mediaConfig` to be loaded by the host's `ConfigModule.forRoot`.
 */
@Module({
  imports: [DatabaseModule, ServicesModule],
  providers: [
    SigningKeyService,
    MediaUrlSigner,
    LocalDiskDriver,
    StorageService,
    {
      provide: STORAGE_DRIVER,
      inject: [ConfigService, LocalDiskDriver],
      useFactory: (config: ConfigService, localDisk: LocalDiskDriver): StorageDriver => {
        const slug = config.getOrThrow<MediaConfig>('media').driver;
        if (slug === localDisk.slug) {
          return localDisk;
        }

        throw new StorageMisconfiguredError(`Unknown storage driver '${slug}'; v1 supports '${localDisk.slug}'`);
      },
    },
  ],
  exports: [StorageService, MediaUrlSigner, SigningKeyService],
})
export class StorageModule {}
