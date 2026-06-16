import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly key: Buffer;

  constructor(private configService: ConfigService) {
    const secret = this.configService.get<string>('BETTER_AUTH_SECRET');
    if (!secret) {
      throw new Error('BETTER_AUTH_SECRET is not defined in the configuration');
    }

    this.key = crypto.createHash('sha256').update(secret).digest();
  }

  /**
   * Encrypts pl
   * Format: iv:tag:ciphertext
   *
   * @param plainText
   * @returns
   */
  encrypt(plainText: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

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
      this.logger.error('Decryption failed', error);
      throw new Error('Failed to decrypt data');
    }
  }

  /**
   * Creates a HMAC signature for the given envelope using the provided secret and algorithm.
   *
   * @param envelope
   * @param secret
   * @param algorithm
   * @returns
   */
  createSignature(envelope: string, secret: string, algorithm = 'sha256'): string {
    return crypto.createHmac(algorithm, secret).update(envelope).digest('hex');
  }

  /**
   * Verifies that the provided signature matches the computed signature for the given envelope and secret.
   *
   * @param envelope
   * @param secret
   * @param signature
   * @param algorithm
   * @returns
   */
  verifySignature(envelope: string, secret: string, signature: string, algorithm = 'sha256'): boolean {
    const computedSignature = this.createSignature(envelope, secret, algorithm);

    const computedBuffer = Buffer.from(computedSignature, 'hex');
    const signatureBuffer = Buffer.from(signature, 'hex');

    if (computedBuffer.length !== signatureBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(computedBuffer, signatureBuffer);
  }
}
