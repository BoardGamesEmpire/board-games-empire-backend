import type { Action, ResourceType } from '@bge/database';
import type { Ability, ForcedSubject, InferSubjects } from '@casl/ability';
import type { Model, PrismaQuery } from '@casl/prisma';

export type Subjects = InferSubjects<`${ResourceType}`> | 'all' | ForcedSubject<Exclude<`${ResourceType}`, 'all'>>;
export type AppAbility = Ability<[Action, Subjects], PrismaQuery<Model<Subjects, `${ResourceType}`>>>;
