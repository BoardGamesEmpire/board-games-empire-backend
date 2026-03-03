import type { Action, ResourceType } from '@bge/database';
import type { ForcedSubject, InferSubjects, PureAbility } from '@casl/ability';
import type { Model, PrismaQuery } from '@casl/prisma';

export type Subjects = InferSubjects<`${ResourceType}`> | 'all' | ForcedSubject<Exclude<`${ResourceType}`, 'all'>>;
export type AppAbility = PureAbility<[Action, Subjects], PrismaQuery<Model<Subjects, `${ResourceType}`>>>;
