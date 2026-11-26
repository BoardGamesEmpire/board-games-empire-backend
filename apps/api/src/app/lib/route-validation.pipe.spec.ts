import type { AuditContextService, EventSource } from '@bge/actor-context';
import type { ArgumentMetadata } from '@nestjs/common';
import { IsString } from 'class-validator';
import { I18nValidationException } from 'nestjs-i18n';
import { RouteValidationPipe } from './route-validation.pipe';

class NamedDto {
  @IsString()
  name!: string;
}

const body: ArgumentMetadata = { type: 'body', metatype: NamedDto };

/** The pipe, in a CLS scope opened by `source`. */
const pipeIn = (source: EventSource | null) =>
  new RouteValidationPipe({ getSource: () => source } as unknown as AuditContextService, {
    forbidNonWhitelisted: true,
    whitelist: true,
    transform: true,
  });

describe('RouteValidationPipe', () => {
  it.each<EventSource | null>(['http', null])("validates a route's parameter (source %s)", async (source) => {
    await expect(pipeIn(source).transform({ name: 42 }, body)).rejects.toBeInstanceOf(I18nValidationException);
    await expect(pipeIn(source).transform({ name: 'Brass' }, body)).resolves.toBeInstanceOf(NamedDto);
  });

  // Nest runs global pipes on a gateway's frames too, and hands their payload
  // over as `body`. The gateway's handlers validate them with their own pipes
  // (#180).
  it("passes a gateway frame's payload through unchanged", async () => {
    const payload = { name: 42, extra: true };

    await expect(pipeIn('ws').transform(payload, body)).resolves.toBe(payload);
  });
});
