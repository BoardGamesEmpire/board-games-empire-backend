import type { UpdateEscalation } from '@bge/plugin';
import { DECORATORS } from '@nestjs/swagger';
import 'reflect-metadata';
import { UpdateEscalationDto } from './plugin-update.response';

/** Every key of every member of the union, not only the keys the members share. */
type KeysOfEach<T> = T extends unknown ? keyof T : never;
type EscalationKey = KeysOfEach<UpdateEscalation>;

// A key a member of the union gains is missing here, which fails the
// typecheck until it is listed, and the test below then asks the DTO to
// document it (#1096).
const ESCALATION_KEYS: Record<EscalationKey, true> = {
  kind: true,
  slug: true,
  consentScope: true,
  required: true,
  scopeType: true,
  decidedRiskLevel: true,
  currentRiskLevel: true,
  domain: true,
  from: true,
  to: true,
  model: true,
};

describe('UpdateEscalationDto', () => {
  const published = (): string[] =>
    Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES_ARRAY, UpdateEscalationDto.prototype) as string[];

  it.each(Object.keys(ESCALATION_KEYS))('documents %s, a key of an update escalation (#1096)', (key) => {
    expect(published()).toContain(`:${key}`);
  });

  it('documents the seven kinds of update escalation as an enum (#1096)', () => {
    const kind = Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, UpdateEscalationDto.prototype, 'kind') as {
      enum: string[];
    };

    expect([...kind.enum].sort()).toEqual(
      [
        'new-permission',
        'permission-promoted-to-required',
        'risk-escalated',
        'outbound-domain-added',
        'outbound-domains-configured',
        'consent-scope-changed',
        'writes-core-added',
      ].sort(),
    );
  });

  it('documents every key but kind as optional, since no member has them all (#1096)', () => {
    const optional = Object.keys(ESCALATION_KEYS)
      .filter((key) => key !== 'kind')
      .filter(
        (key) =>
          (
            Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, UpdateEscalationDto.prototype, key) as {
              required?: boolean;
            }
          ).required === false,
      );

    expect(optional).toEqual(Object.keys(ESCALATION_KEYS).filter((key) => key !== 'kind'));
  });
});
