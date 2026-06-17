import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly key: Buffer;

  constructor(private configService: ConfigService) {
    const secret = this.configService.get<string>('system.encryption_key');
    if (!secret) {
      throw new Error('DATA_ENCRYPTION_KEY is not defined in the configuration');
    }

    this.key = crypto.createHash('sha256').update(secret).digest();
  }

  /**
   * Encrypts a plaintext string with AES-256-GCM.
   * Returns `iv:tag:ciphertext` (all hex, colon-delimited) — everything
   * `decrypt` needs to reverse it.
   *
   * @param plainText value to encrypt
   * @returns `iv:tag:ciphertext`
   */
  encrypt(plainText: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypts an encrypted string with AES-256-GCM.
   * Expects `iv:tag:ciphertext` format (all hex, colon-delimited).
   *
   * @param encryptedText value to decrypt
   * @returns decrypted plaintext
   */
  decrypt(encryptedText: string): string {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted text format');
    }

    try {
      const iv = Buffer.from(parts[0], 'hex');
      const tag = Buffer.from(parts[1], 'hex');
      const encrypted = Buffer.from(parts[2], 'hex');

      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString('utf8');
    } catch (error) {
      this.logger.error('Decryption failed', error instanceof Error ? error.stack : String(error));
      throw new Error('Failed to decrypt data');
    }
  }
}
