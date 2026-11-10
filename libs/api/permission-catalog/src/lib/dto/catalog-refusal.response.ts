import type { EntryProblem } from '@bge/database';
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';

/**
 * OpenAPI models for the bodies the permission catalog's routes refuse an
 * edit with (#772), so a client can render each problem from its `kind` and
 * fields instead of the message alone. One model per shape of entry problem;
 * `PROBLEM_MODELS` maps every kind the check reports to its model, and fails
 * the typecheck when the check gains a kind this file does not describe.
 */

type ProblemOf<Kind extends EntryProblem['kind']> = Extract<EntryProblem, { kind: Kind }>;

const SLUG_DESCRIPTION = 'The permission the problem is about.';
const ROLE_DESCRIPTION = 'The role holding the permission.';

export class TemplateProblemDto implements ProblemOf<'template'> {
  @ApiProperty({
    enum: ['template'],
    description: 'The condition is not a template the server can render, or names a value no context supplies.',
  })
  kind!: 'template';

  @ApiProperty({ description: SLUG_DESCRIPTION })
  slug!: string;

  @ApiProperty({
    description:
      'What is wrong with the template, such as `unknown-variable: user.name`: diagnostic text in English, for ' +
      'the person fixing the condition. `kind` is the stable part.',
  })
  detail!: string;
}

export class ShorthandRelationProblemDto implements ProblemOf<'shorthand-relation'> {
  @ApiProperty({
    enum: ['shorthand-relation'],
    description: 'A relation in the condition is written without `is`, which the permission checks cannot read.',
  })
  kind!: 'shorthand-relation';

  @ApiProperty({ description: SLUG_DESCRIPTION })
  slug!: string;

  @ApiProperty({ description: 'Where in the condition, as dotted keys.' })
  path!: string;
}

export class RoleProblemDto {
  @ApiProperty({
    enum: ['fails-open', 'unbounded-on-floor-role', 'event-spanning'],
    description:
      'fails-open: a household or event role holds the permission with no condition, so it reaches every ' +
      'household or event. unbounded-on-floor-role: the role anonymous visitors hold would reach records no ' +
      "condition limits. event-spanning: an event role's condition does not keep it to its own event.",
  })
  kind!: 'fails-open' | 'unbounded-on-floor-role' | 'event-spanning';

  @ApiProperty({ description: SLUG_DESCRIPTION })
  slug!: string;

  @ApiProperty({ description: ROLE_DESCRIPTION })
  role!: string;
}

export class CannotRenderProblemDto implements ProblemOf<'cannot-render'> {
  @ApiProperty({
    enum: ['cannot-render'],
    description: 'The condition names values the role never supplies, so it would match nothing for that role.',
  })
  kind!: 'cannot-render';

  @ApiProperty({ description: SLUG_DESCRIPTION })
  slug!: string;

  @ApiProperty({ description: ROLE_DESCRIPTION })
  role!: string;

  @ApiProperty({ type: [String], description: 'The values the role does not supply.' })
  variables!: readonly string[];
}

export class ReadsPastReachProblemDto implements ProblemOf<'reads-past-reach'> {
  @ApiProperty({
    enum: ['reads-past-reach'],
    description: 'A role every visitor or user holds would read records past the reach their owners chose for them.',
  })
  kind!: 'reads-past-reach';

  @ApiProperty({ description: SLUG_DESCRIPTION })
  slug!: string;

  @ApiProperty({ description: ROLE_DESCRIPTION })
  role!: string;

  @ApiProperty({ description: 'The resource type read.' })
  subject!: string;

  @ApiProperty({
    enum: ['every row', 'fixed filter'],
    description: 'How much it reads: every record, or every record a fixed filter lets through.',
  })
  reads!: ProblemOf<'reads-past-reach'>['reads'];
}

export class NamesOtherRolesProblemDto implements ProblemOf<'names-other-roles'> {
  @ApiProperty({
    enum: ['names-other-roles'],
    description: 'The condition names roles, none of them the one holding it, so for that role it confers nothing.',
  })
  kind!: 'names-other-roles';

  @ApiProperty({ description: SLUG_DESCRIPTION })
  slug!: string;

  @ApiProperty({ description: ROLE_DESCRIPTION })
  role!: string;

  @ApiProperty({ type: [String], description: 'The roles the condition names.' })
  named!: readonly string[];
}

export class SubjectHasNoModelProblemDto implements ProblemOf<'subject-has-no-model'> {
  @ApiProperty({
    enum: ['subject-has-no-model'],
    description: 'The permission has a condition, but its resource type has no records a condition could select.',
  })
  kind!: 'subject-has-no-model';

  @ApiProperty({ description: SLUG_DESCRIPTION })
  slug!: string;

  @ApiProperty({ description: 'The resource type, such as all.' })
  subject!: string;
}

export class QueryRejectedProblemDto implements ProblemOf<'query-rejected'> {
  @ApiProperty({
    enum: ['query-rejected'],
    description:
      'The database cannot run the condition: a field it lacks, an operator in the wrong place, or a value of the wrong kind.',
  })
  kind!: 'query-rejected';

  @ApiProperty({ description: SLUG_DESCRIPTION })
  slug!: string;

  @ApiProperty({
    description:
      "The database's reason, as it gives it: diagnostic text in English, for the person fixing the condition. " +
      '`kind` is the stable part.',
  })
  message!: string;
}

/** Every kind of entry problem and its model. A kind missing here fails the typecheck. */
const PROBLEM_MODELS: Readonly<Record<EntryProblem['kind'], abstract new () => object>> = {
  template: TemplateProblemDto,
  'shorthand-relation': ShorthandRelationProblemDto,
  'fails-open': RoleProblemDto,
  'unbounded-on-floor-role': RoleProblemDto,
  'event-spanning': RoleProblemDto,
  'cannot-render': CannotRenderProblemDto,
  'reads-past-reach': ReadsPastReachProblemDto,
  'names-other-roles': NamesOtherRolesProblemDto,
  'subject-has-no-model': SubjectHasNoModelProblemDto,
  'query-rejected': QueryRejectedProblemDto,
};

const PROBLEM_MODEL_LIST = [...new Set(Object.values(PROBLEM_MODELS))];

/** The 422 body of a permission edit, and of a grant added or revoked. */
@ApiExtraModels(...PROBLEM_MODEL_LIST)
export class CatalogEditRefusalDto {
  @ApiProperty({
    enum: ['CATALOG_ENTRY_REFUSED', 'CATALOG_OWNER_LOCKOUT'],
    description:
      'CATALOG_ENTRY_REFUSED: the edit fails the entry check, and `problems` says why. CATALOG_OWNER_LOCKOUT: the ' +
      'edit would leave the Owner without full control of the server.',
  })
  code!: 'CATALOG_ENTRY_REFUSED' | 'CATALOG_OWNER_LOCKOUT';

  @ApiProperty({ description: 'What happened, in the language of the request.' })
  message!: string;

  @ApiPropertyOptional({
    description: 'With CATALOG_ENTRY_REFUSED, each problem the entry check found, by `kind`.',
    type: 'array',
    items: {
      oneOf: PROBLEM_MODEL_LIST.map((model) => ({ $ref: getSchemaPath(model) })),
      discriminator: {
        propertyName: 'kind',
        mapping: Object.fromEntries(
          Object.entries(PROBLEM_MODELS).map(([kind, model]) => [kind, getSchemaPath(model)]),
        ),
      },
    },
  })
  problems?: EntryProblem[];
}

/** The body of the other coded refusals: 404, and 409. */
export class CatalogErrorDto {
  @ApiProperty({
    description:
      'Stable, for a client to act on: CATALOG_ENTRY_NOT_FOUND, CATALOG_ENTRY_NOT_EDITABLE, CATALOG_ENTRY_CHANGED, ' +
      'CATALOG_PERMISSION_RETIRED or CATALOG_ROLE_NOT_JUDGEABLE.',
  })
  code!: string;

  @ApiProperty({ description: 'What happened, in the language of the request.' })
  message!: string;
}
