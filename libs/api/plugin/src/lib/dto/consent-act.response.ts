import { PluginUnitDormantReason, type PluginConsentAct } from '@bge/database';
import type { ConsentActKind, ConsentActResult } from '@bge/plugin';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * OpenAPI model for the answer to a consent act (#1150): switching a plugin
 * on, toggling one requested permission, or a review, at household or user
 * scope. As in `consent-surface.response.ts`, the act summary `implements`
 * the runtime shape it models, so a renamed field is a compile error here.
 * `ConsentActUnitDto` describes either unit enablement, a household's or a
 * user's, so it lists every field the two rows return by hand.
 */

const CONSENT_ACT_KINDS: readonly ConsentActKind[] = ['SwitchOn', 'Toggle', 'Review'];

class ConsentActSummaryDto implements Pick<PluginConsentAct, 'id' | 'decidedAt'> {
  @ApiProperty({ description: 'The recorded consent act' })
  id!: string;

  @ApiProperty({ enum: CONSENT_ACT_KINDS, description: 'Which consent act this was' })
  kind!: ConsentActKind;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the consent act was recorded' })
  decidedAt!: Date;
}

/** The unit enablement after the consent act: a household's or your own. */
class ConsentActUnitDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  pluginId!: string;

  @ApiPropertyOptional({ description: 'Present for a household unit' })
  householdId?: string;

  @ApiPropertyOptional({ description: 'Present for your own unit' })
  userId?: string;

  @ApiProperty({ description: "The unit's own switch: true when the plugin is switched on here" })
  enabled!: boolean;

  @ApiProperty({ type: 'object', additionalProperties: true, description: 'The unit configuration' })
  config!: Record<string, unknown>;

  @ApiPropertyOptional({
    enum: PluginUnitDormantReason,
    nullable: true,
    description:
      'Household unit only. Why the unit is switched on but serves nothing until it is cured; null when it serves.',
  })
  dormantReason?: PluginUnitDormantReason | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Household unit only. When the unit became dormant; null when it serves.',
  })
  dormantAt?: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class ConsentActResponseDto {
  @ApiProperty({ description: 'Plain-language confirmation, localized' })
  message!: string;

  @ApiProperty({
    description:
      'False when the answers matched what was already recorded: nothing was written, and act is null. The ' +
      'route still answers 200, so repeating a consent act is safe.',
  })
  changed!: boolean;

  @ApiProperty({
    description:
      'True when a review refuses a required permission, so the plugin is switched off here: by this consent ' +
      'act, or already, when the review repeats a refusal that left it off (changed is then false). Always ' +
      'false for a switch-on or a toggle.',
  })
  switchedOff!: boolean;

  @ApiProperty({ type: ConsentActSummaryDto, nullable: true, description: 'The recorded consent act, or null' })
  act!: ConsentActSummaryDto | null;

  @ApiProperty({ type: ConsentActUnitDto })
  unit!: ConsentActUnitDto;
}

/**
 * The body every consent act route answers with (#1150): the act's summary
 * rather than its stored presentation, which the client already showed.
 */
export function consentActResponse<M>(message: M, result: ConsentActResult) {
  const { act, changed, switchedOff, unit } = result;

  return {
    message,
    changed,
    switchedOff,
    act: act === null ? null : { id: act.id, kind: act.kind, decidedAt: act.decidedAt },
    unit,
  };
}
