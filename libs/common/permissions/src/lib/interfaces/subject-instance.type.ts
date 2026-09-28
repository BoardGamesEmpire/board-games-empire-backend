import type { Prisma } from '@bge/database';
import type { ModelResourceType } from './model-resource-type.type';

/**
 * The row an instance check describes, as far as the grants' conditions need
 * it: what `AbilityService.assertCurrentActorCan` is asked about (#456).
 *
 * Derived from the generated client's payload type for the model, so it
 * follows the schema. Every scalar is optional and keeps its column type. A
 * to-one relation is the related model's instance, or `null` where the
 * relation is optional, and a to-many relation is an array of them. Each call
 * site passes an object literal, so the excess-property check turns a
 * misspelt key (`household_id`) or a renamed relation into a compile error.
 * Untyped, either reached the matcher as a field no condition names, and the
 * check denied with nothing to say why.
 */
export type SubjectInstance<TResource extends ModelResourceType> = PayloadInstance<
  Prisma.TypeMap['model'][TResource]['payload']
>;

interface ModelPayload {
  scalars: object;
  objects: object;
}

type PayloadInstance<TPayload extends ModelPayload> = Partial<TPayload['scalars']> & {
  [TRelation in keyof TPayload['objects']]?: RelationInstance<TPayload['objects'][TRelation]>;
};

// Distributes over `| null`, so an optional to-one relation keeps its `null`.
type RelationInstance<TRelated> = TRelated extends readonly (infer TElement)[]
  ? RelationInstance<TElement>[]
  : TRelated extends ModelPayload
    ? PayloadInstance<TRelated>
    : TRelated;
