import type { Prisma, ResourceType } from '../client';
import type { PermissionSeedDefinition } from './seed-definitions';

/**
 * Compile-time validation of a catalog entry's `conditions` and `fields`
 * against the Prisma types of its own `subject` (#234).
 *
 * A seeded condition is a Prisma `where` clause with Mustache placeholders in
 * its values. The ability factory renders it into a CASL rule, and
 * `accessibleBy()` turns that rule back into a Prisma `where` at query time,
 * so a path that does not exist on the model fails on the first query that
 * uses it, not at seed time — two such paths shipped latent during #155/#156.
 * Prisma's `prisma-client` generator exports no runtime DMMF to walk, so the
 * catalog carries its types instead: every entry is written through
 * {@link permission}, whose parameter types the `conditions` object as the
 * subject's `WhereInput` and the `fields` array as the subject's scalar-field
 * enum. The compiler then rejects an unknown scalar, an unknown relation, an
 * operator in the wrong position and a `fields` entry that is not a column,
 * naming the file, line and property, and `database:typecheck` is the gate.
 * The negative cases live in `permission-entry.spec.ts`.
 *
 * What the gate does NOT see: value types where the column accepts strings.
 * A placeholder is a string, and a `DateTime`, `Decimal` or `Json` column
 * takes strings too, so `createdAt: '{{ eventId }}'` compiles and would still
 * fail on the first query. Enum, number and boolean columns reject a
 * placeholder outright. Every render-context variable is an identifier, so
 * the shipped-catalog spec pins placeholders to identifier columns as the
 * runtime tripwire for that gap. Nor does it see a value kind a `WhereInput`
 * admits but JSON has no literal for — a `Date`, a `bigint`, a `FieldRef` —
 * which `assertJsonConditions` refuses when the catalog module loads.
 *
 * Keys are the `ResourceType` literals, which are also the Prisma model
 * names. Both maps are written out and wrapped in {@link ForEverySubject}
 * rather than derived from `Prisma.TypeMap`, so a `ResourceType` member that
 * is added without a row here fails the build instead of silently becoming
 * `never` — the body of #234 asked for subject resolution to be confirmed,
 * not assumed. A member with no model of its own IS `never`: conditions on it
 * cannot compile, because nothing could evaluate them.
 */

/** Every subject a catalog entry may name: a `ResourceType` member or the wildcard. */
export type CatalogSubject = ResourceType | 'all';

/**
 * Requires `T` to carry a row for every {@link CatalogSubject}. Applied to
 * both maps below so that adding a `ResourceType` member without classifying
 * it here is a compile error at the map, not a `never` discovered later.
 */
type ForEverySubject<T extends Record<CatalogSubject, unknown>> = T;

/** The Prisma `WhereInput` a subject's conditions are checked against. */
export type SubjectWhereInput = ForEverySubject<{
  // System
  System: never; // no model
  AuditLog: Prisma.AuditLogWhereInput;
  Notification: Prisma.NotificationWhereInput;
  SafeHttpPolicy: Prisma.SafeHttpPolicyWhereInput;
  Media: Prisma.MediaWhereInput;
  MediaObject: Prisma.MediaObjectWhereInput;
  MediaContribution: Prisma.MediaContributionWhereInput;
  WebhookSubscription: Prisma.WebhookSubscriptionWhereInput;
  Quota: Prisma.QuotaWhereInput;
  Job: Prisma.JobWhereInput;
  // Plugin
  Plugin: Prisma.PluginWhereInput;
  PluginGrant: Prisma.PluginGrantWhereInput;
  HouseholdPlugin: Prisma.HouseholdPluginWhereInput;
  UserPlugin: Prisma.UserPluginWhereInput;
  PluginLifecycleEvent: Prisma.PluginLifecycleEventWhereInput;
  // User
  User: Prisma.UserWhereInput;
  UserProfile: Prisma.UserProfileWhereInput;
  UserGameCustomization: Prisma.UserGameCustomizationWhereInput;
  Friendship: Prisma.FriendshipWhereInput;
  // Feedback
  FeedbackReport: Prisma.FeedbackReportWhereInput;
  FeedbackSinkDispatch: never; // no model
  // Game
  Campaign: never; // no model
  Game: Prisma.GameWhereInput;
  GameCollection: Prisma.GameCollectionWhereInput;
  GameCreationRequest: never; // no model
  GameCustomization: never; // no model
  GameGateway: Prisma.GameGatewayWhereInput;
  GamePlayResult: Prisma.GamePlayResultWhereInput;
  GamePlaySession: Prisma.GamePlaySessionWhereInput;
  GameSharing: never; // no model
  Platform: Prisma.PlatformWhereInput;
  PlatformGame: Prisma.PlatformGameWhereInput;
  RuleVariant: Prisma.RuleVariantWhereInput;
  SessionPlayer: Prisma.SessionPlayerWhereInput;
  // Household
  Household: Prisma.HouseholdWhereInput;
  HouseholdMember: Prisma.HouseholdMemberWhereInput;
  HouseholdRole: Prisma.HouseholdRoleWhereInput;
  Invite: Prisma.InviteWhereInput;
  // Event
  Event: Prisma.EventWhereInput;
  EventAttendee: Prisma.EventAttendeeWhereInput;
  EventAttendeeGameList: Prisma.EventAttendeeGameListWhereInput;
  EventAvailabilityVote: Prisma.EventAvailabilityVoteWhereInput;
  EventGame: Prisma.EventGameWhereInput;
  EventGameNomination: Prisma.EventGameNominationWhereInput;
  EventGameVote: Prisma.EventGameVoteWhereInput;
  EventOccurrence: Prisma.EventOccurrenceWhereInput;
  EventPolicy: Prisma.EventPolicyWhereInput;
  all: never; // the wildcard filters nothing
}>;

/** The Prisma scalar-field enum a subject's `fields` entries are checked against. */
export type SubjectScalarField = ForEverySubject<{
  // System
  System: never; // no model
  AuditLog: Prisma.AuditLogScalarFieldEnum;
  Notification: Prisma.NotificationScalarFieldEnum;
  SafeHttpPolicy: Prisma.SafeHttpPolicyScalarFieldEnum;
  Media: Prisma.MediaScalarFieldEnum;
  MediaObject: Prisma.MediaObjectScalarFieldEnum;
  MediaContribution: Prisma.MediaContributionScalarFieldEnum;
  WebhookSubscription: Prisma.WebhookSubscriptionScalarFieldEnum;
  Quota: Prisma.QuotaScalarFieldEnum;
  Job: Prisma.JobScalarFieldEnum;
  // Plugin
  Plugin: Prisma.PluginScalarFieldEnum;
  PluginGrant: Prisma.PluginGrantScalarFieldEnum;
  HouseholdPlugin: Prisma.HouseholdPluginScalarFieldEnum;
  UserPlugin: Prisma.UserPluginScalarFieldEnum;
  PluginLifecycleEvent: Prisma.PluginLifecycleEventScalarFieldEnum;
  // User
  User: Prisma.UserScalarFieldEnum;
  UserProfile: Prisma.UserProfileScalarFieldEnum;
  UserGameCustomization: Prisma.UserGameCustomizationScalarFieldEnum;
  Friendship: Prisma.FriendshipScalarFieldEnum;
  // Feedback
  FeedbackReport: Prisma.FeedbackReportScalarFieldEnum;
  FeedbackSinkDispatch: never; // no model
  // Game
  Campaign: never; // no model
  Game: Prisma.GameScalarFieldEnum;
  GameCollection: Prisma.GameCollectionScalarFieldEnum;
  GameCreationRequest: never; // no model
  GameCustomization: never; // no model
  GameGateway: Prisma.GameGatewayScalarFieldEnum;
  GamePlayResult: Prisma.GamePlayResultScalarFieldEnum;
  GamePlaySession: Prisma.GamePlaySessionScalarFieldEnum;
  GameSharing: never; // no model
  Platform: Prisma.PlatformScalarFieldEnum;
  PlatformGame: Prisma.PlatformGameScalarFieldEnum;
  RuleVariant: Prisma.RuleVariantScalarFieldEnum;
  SessionPlayer: Prisma.SessionPlayerScalarFieldEnum;
  // Household
  Household: Prisma.HouseholdScalarFieldEnum;
  HouseholdMember: Prisma.HouseholdMemberScalarFieldEnum;
  HouseholdRole: Prisma.HouseholdRoleScalarFieldEnum;
  Invite: Prisma.InviteScalarFieldEnum;
  // Event
  Event: Prisma.EventScalarFieldEnum;
  EventAttendee: Prisma.EventAttendeeScalarFieldEnum;
  EventAttendeeGameList: Prisma.EventAttendeeGameListScalarFieldEnum;
  EventAvailabilityVote: Prisma.EventAvailabilityVoteScalarFieldEnum;
  EventGame: Prisma.EventGameScalarFieldEnum;
  EventGameNomination: Prisma.EventGameNominationScalarFieldEnum;
  EventGameVote: Prisma.EventGameVoteScalarFieldEnum;
  EventOccurrence: Prisma.EventOccurrenceScalarFieldEnum;
  EventPolicy: Prisma.EventPolicyScalarFieldEnum;
  all: never; // the wildcard filters nothing
}>;

/**
 * A catalog entry as written for one subject: {@link PermissionSeedDefinition}
 * with `conditions` and `fields` retyped by the entry's own `subject`. Derived
 * from the definition rather than restated, so a member added there — a
 * required one in particular, as `riskLevel` is (#60) — is required of every
 * entry without anyone remembering to mirror it. `S` is inferred from
 * `subject`, so the two cannot disagree, and the object literal is fresh, so
 * excess-property checks reach every nested level of `conditions`. `S` must
 * be one member: against a `subject` typed as the whole enum the check would
 * widen to every subject's filters at once, and a path from some other model
 * would pass, so {@link permission} refuses such a subject.
 */
export type PermissionEntryFor<S extends CatalogSubject, Slug extends string> = Readonly<
  Omit<PermissionSeedDefinition, 'subject' | 'slug' | 'conditions' | 'fields'>
> & {
  readonly subject: S;
  readonly slug: Slug;
  readonly conditions?: SubjectWhereInput[S];
  readonly fields?: readonly SubjectScalarField[S][];
};

/** `true` when `T` is a union of more than one member. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * The rest parameter of {@link permission}: empty when `subject` is one
 * member, and a required argument that cannot be supplied when it is a union,
 * so the call fails "an argument for 'subjectMustBeOneMember' was not
 * provided". A guard on the entry's own type would sit in the contextual type
 * of `subject` and widen the `'all'` literal to `string` during inference,
 * refusing the wildcard entries instead; a parameter after the entry leaves
 * that inference alone. Every catalog entry names its subject as a literal.
 */
type OneSubjectGuard<S extends CatalogSubject> = IsUnion<S> extends true ? [subjectMustBeOneMember: never] : [];

/**
 * Marks a definition as having come through {@link permission}. Declared and
 * never present at runtime — the builder returns its argument — so it proves
 * nothing about the object; its one job is to make the catalog's element type
 * unreachable from an object literal. An entry written without the builder
 * was never checked against its subject, and with this member required of
 * every element, it does not compile instead of shipping unchecked.
 */
declare const checkedAgainstSubject: unique symbol;

/**
 * What {@link permission} returns: the {@link PermissionSeedDefinition} every
 * consumer reads, with `subject` and `slug` kept literal. Readonly, as the
 * `as const` catalog was before the builder: the seed, the guards and the
 * reconciler all read the one module-level array, and none of them may
 * change it. `PERMISSION_CATALOG` is typed as an array of these, so an entry
 * written as a plain literal cannot be put in it; every consumer still reads
 * the array as `readonly PermissionSeedDefinition[]`. A spread of a built
 * entry keeps the marker, so `{ ...built, conditions: {...} }` compiles with
 * conditions nobody checked. No member typing closes that: retyping
 * `conditions` here by the subject either changes nothing (intersected with
 * the JSON object type, its index signature admits any key) or breaks the
 * seed's `PermissionSeedDefinition` view (a `WhereInput` is not JSON), and a
 * spread can also drop `conditions` or swap `subject`. That is a review
 * matter; the import-time assertions and the placeholder tripwire still run
 * over whatever the array holds, but neither checks paths.
 */
export type DefinedPermission<S extends CatalogSubject, Slug extends string> = Readonly<PermissionSeedDefinition> & {
  readonly subject: S;
  readonly slug: Slug;
  readonly [checkedAgainstSubject]: true;
};

/**
 * Declares one catalog entry. Returns its argument unchanged, typed as the
 * {@link PermissionSeedDefinition} every consumer reads — the seed, the
 * guards, the reconciler and the factory specs see `conditions` as the JSON
 * object it is written to the database as — while keeping `subject` and
 * `slug` literal so `PermissionSlug` stays a union of the shipped slugs.
 *
 * The cast is the one place the two views meet, and `conditions` is the only
 * member it bridges: every other member is the definition's own. A
 * `WhereInput` also admits a `Date`, a `bigint` or a `FieldRef`, so the
 * compiler cannot prove the argument is JSON, and nothing downstream would
 * refuse one: Prisma's Json column write is `JSON.stringify` under a replacer
 * that turns it into a different filter, and the factory renders the row it
 * read back. `assertJsonConditions` at the catalog's foot is what makes the
 * cast true: it walks every entry as the module loads and names the slug and
 * path of any value that is not JSON as written.
 */
export function permission<S extends CatalogSubject, const Slug extends string>(
  entry: PermissionEntryFor<S, Slug>,
  ...guard: OneSubjectGuard<S>
): DefinedPermission<S, Slug>;
export function permission<S extends CatalogSubject, const Slug extends string>(
  entry: PermissionEntryFor<S, Slug>,
): DefinedPermission<S, Slug> {
  return entry as DefinedPermission<S, Slug>;
}
