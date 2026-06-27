import { DatabaseService } from '@bge/database';
import { EncryptionService } from '@bge/services';
import { StorageMisconfiguredError } from '@boardgamesempire/storage-contract';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Loads, decrypts, and caches the media signing secret from the `SystemSetting`
 * singleton. Stored encrypted (EncryptionService) so it can be seeded and rotated
 * by an admin without a redeploy. Rotation invalidates all outstanding signed
 * URLs at once — acceptable given short TTLs; call `invalidate()` after rotating
 * so the next sign/verify re-reads.
 */
@Injectable()
export class SigningKeyService {
  private readonly logger = new Logger(SigningKeyService.name);
  private cached: string | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly encryption: EncryptionService,
  ) {}

  async getSecret(): Promise<string> {
    if (this.cached !== null) {
      return this.cached;
    }

    const settings = await this.db.systemSetting.findUnique({ where: { singleton: true } });
    if (!settings?.mediaSigningSecret) {
      throw new StorageMisconfiguredError(
        'Media signing secret is not configured; seed SystemSetting.mediaSigningSecret',
      );
    }

    const secret = this.encryption.decrypt(settings.mediaSigningSecret);
    if (!secret) {
      throw new StorageMisconfiguredError('Media signing secret decrypted to an empty value');
    }

    this.cached = secret;
    return secret;
  }

  /** Clear the cached secret so the next access re-reads from the database (after rotation). */
  invalidate(): void {
    this.cached = null;

    this.logger.debug('SigningKeyService cache invalidated; next getSecret() will re-read from database');
  }
}
