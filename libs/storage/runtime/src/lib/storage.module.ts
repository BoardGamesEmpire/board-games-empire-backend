import { DatabaseModule } from '@bge/database';
import { ServicesModule } from '@bge/services';
import type { StorageDriver } from '@boardgamesempire/storage-contract';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalDiskDriver } from './local-disk.driver.js';
import { MediaUrlSigner } from './media-url-signer.js';
import type { MediaConfig } from './media.config.js';
import { SigningKeyService } from './signing-key.service.js';
import { StorageService } from './storage.service.js';
import { STORAGE_DEFAULT_WRITE_SLUG, STORAGE_DRIVERS } from './storage.tokens.js';

/**
 * Wires the storage runtime. Every driver provider is registered into
 * `STORAGE_DRIVERS`; `StorageService` routes object-addressed ops by the object's
 * recorded slug and stamps new writes with `STORAGE_DEFAULT_WRITE_SLUG`
 * (`media.driver`). v1 ships one driver (LocalDisk); further drivers register here
 * as they land (the registry/write-default invariants are enforced by the router
 * at construction, #100). Requires `mediaConfig` loaded by the host's
 * `ConfigModule.forRoot`.
 */
@Module({
  imports: [DatabaseModule, ServicesModule],
  providers: [
    SigningKeyService,
    MediaUrlSigner,
    LocalDiskDriver,
    StorageService,
    {
      provide: STORAGE_DRIVERS,
      inject: [LocalDiskDriver],
      useFactory: (localDisk: LocalDiskDriver): readonly StorageDriver[] => [localDisk],
    },
    {
      provide: STORAGE_DEFAULT_WRITE_SLUG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): string => config.getOrThrow<MediaConfig>('media').driver,
    },
  ],
  exports: [StorageService, MediaUrlSigner, SigningKeyService],
})
export class StorageModule {}
