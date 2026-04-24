import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DateTime } from 'luxon';

/**
 * Builds the RFC 9116 security.txt document.
 *
 * Returns null when no contact is configured — the controller
 * responds with 404 in that case. Serving a security.txt with
 * no contact information is less useful than not serving one at all.
 *
 * The `Expires` field is auto-computed as one year from the current
 * date at midnight UTC if SECURITY_EXPIRES is not explicitly set.
 * With Cache-Control: max-age=86400 this is stable within the cache
 * window and changes only as the calendar date rolls over.
 *
 * The `Canonical` field is always auto-derived from the issuer URL
 * so it stays consistent regardless of reverse proxy configuration.
 */
@Injectable()
export class SecurityTxtService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Builds the security.txt document body.
   *
   * @param issuer - The canonical base URL of this server (auth.url).
   *   Used to construct the Canonical field.
   * @param now - The reference instant for Expires auto-computation.
   *   Injectable for deterministic testing.
   */
  build(issuer: string, now: Date = new Date()): string | null {
    const contacts = this.configService.get<string[]>('security.contact') ?? [];

    if (contacts.length === 0) {
      return null;
    }

    const lines: string[] = [
      '# Security contact information for Board Games Empire',
      '# https://securitytxt.org — RFC 9116',
      '',
    ];

    for (const contact of contacts) {
      lines.push(`Contact: ${contact}`);
    }

    const expires = this.resolveExpires(now);
    lines.push(`Expires: ${expires}`);

    lines.push(`Canonical: ${issuer}/.well-known/security.txt`);

    const policy = this.configService.get<string>('security.policy');
    if (policy) lines.push(`Policy: ${policy}`);

    const encryption = this.configService.get<string>('security.encryption');
    if (encryption) lines.push(`Encryption: ${encryption}`);

    const acknowledgments = this.configService.get<string>('security.acknowledgments');
    if (acknowledgments) lines.push(`Acknowledgments: ${acknowledgments}`);

    const preferredLanguages = this.configService.get<string>('security.preferredLanguages');
    if (preferredLanguages) lines.push(`Preferred-Languages: ${preferredLanguages}`);

    const hiring = this.configService.get<string>('security.hiring');
    if (hiring) lines.push(`Hiring: ${hiring}`);

    // Trailing newline required per RFC 9116 §3
    return lines.join('\n') + '\n';
  }

  /**
   * Whether the endpoint should be served at all.
   * Used by the controller to decide between 200 and 404.
   */
  isConfigured(): boolean {
    const contacts = this.configService.get<string[]>('security.contact') ?? [];
    return contacts.length > 0;
  }

  private resolveExpires(now: Date): string {
    const explicit = this.configService.get<string>('security.expires');
    if (explicit) {
      return explicit;
    }

    const expiry = DateTime.fromJSDate(now).toUTC().plus({ years: 1 }).startOf('day');
    return expiry.toISO() as string;
  }
}
