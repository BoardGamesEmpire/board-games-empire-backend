import { i18nValidationMessage } from '@bge/i18n-core';
import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Wire-contract cap on a client request id (#210, #251, #252). Generous enough
 * for any client id scheme (the Flutter client sends a cuid2), tight enough that
 * the unique index never carries unbounded input.
 */
export const MAX_CLIENT_REQUEST_ID_LENGTH = 128;

/**
 * The optional `clientRequestId` of a create a client may retry (#252). Every
 * keyed create validates its key the same way, so a client learns one rule.
 *
 * `subject` names the record in the API description: 'household', 'event',
 * 'feedback report'. `onReplay`, where given, is a sentence telling the
 * client what a repeat does not do again, such as notify or forward. An update
 * DTO derived from the create must omit the field (#534): an edit that rewrote
 * the key would strand the retry it exists for.
 */
export function ClientRequestIdProperty(subject: string, onReplay?: string): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      description:
        'A key the client chooses for this create, scoped per user. A repeat POST with the same key returns ' +
        `the ORIGINAL ${subject} (same id, answered 201 again) instead of creating a duplicate, even if ` +
        'something it depended on has changed since. The repeat still needs the right to make this kind of ' +
        'create at all: a user refused it since, by a ban for instance, is refused the repeat too. ' +
        (onReplay ? `${onReplay} ` : '') +
        "The repeat's payload is ignored: the first writer wins. " +
        'Keys are kept as long as the record is. Surrounding whitespace is trimmed; a blank key is rejected ' +
        'rather than silently ignored.',
      minLength: 1,
      maxLength: MAX_CLIENT_REQUEST_ID_LENGTH,
    }),
    IsOptional(),
    IsString({ message: i18nValidationMessage('validation.isString') }),
    MinLength(1, { message: i18nValidationMessage('validation.minLength') }),
    MaxLength(MAX_CLIENT_REQUEST_ID_LENGTH, { message: i18nValidationMessage('validation.maxLength') }),
    // Trim before length validation so a whitespace-only key collapses to '' and
    // fails MinLength (a 400) rather than reaching the service, where it would be
    // normalized away and silently cost the caller its retry guarantee. Trimming
    // also makes retries that differ only in padding resolve to one key.
    //
    // Reads the request's own value, not `value`: the global pipe's implicit
    // conversion has already made a number '5' and an object '[object Object]'
    // by then, and every object-keyed create by a user would share that one key,
    // the second silently replaying the first. Left as sent, a non-string fails
    // IsString instead.
    Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
      const sent = obj[key];

      return typeof sent === 'string' ? sent.trim() : sent;
    }),
  );
}
