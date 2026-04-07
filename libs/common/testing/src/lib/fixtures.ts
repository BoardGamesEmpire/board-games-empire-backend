import {
  Action,
  ContentType,
  Event,
  EventSchedulingMode,
  EventStatus,
  EventType,
  Game,
  GameCollection,
  GameRelease,
  Household,
  HouseholdMember,
  InitiatorType,
  Invite,
  InviteStatus,
  InviteType,
  Job,
  JobStatus,
  JobType,
  Permission,
  Platform,
  Role,
  Session,
  TimeMeasure,
  User,
  UserRole,
  Visibility,
} from '@bge/database';

let _seq = 0;
const seq = () => String(++_seq);

export function makeUser(overrides: Partial<User> = {}): User {
  const n = seq();
  return {
    id: `user-${n}`,
    username: `user_${n}`,
    email: `user${n}@example.com`,
    emailVerified: true,
    banned: false,
    banExpires: null,
    banReason: null,
    isAnonymous: false,
    image: null,
    firstName: 'Test',
    lastName: 'User',
    twoFactorEnabled: false,
    role: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeSession(userId: string, overrides: Partial<Session> = {}): Session {
  const n = seq();
  return {
    id: `session-${n}`,
    userId,
    token: `token-${n}`,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
    impersonatedBy: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeRole(overrides: Partial<Role> = {}): Role {
  const n = seq();
  return {
    id: `role-${n}`,
    name: `Role_${n}`,
    description: null,
    isSystem: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makePermission(overrides: Partial<Permission> = {}): Permission {
  const n = seq();
  return {
    id: `perm-${n}`,
    action: Action.read,
    subject: 'Game',
    fields: [],
    conditions: null,
    inverted: false,
    reason: null,
    slug: `read:game:${n}`,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeUserRole(userId: string, roleId: string, overrides: Partial<UserRole> = {}): UserRole {
  return {
    id: `ur-${seq()}`,
    userId,
    roleId,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeHousehold(overrides: Partial<Household> = {}): Household {
  const n = seq();
  return <Household>{
    id: `household-${n}`,
    name: `Household ${n}`,
    description: null,
    image: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeHouseholdMember(
  userId: string,
  householdId: string,
  overrides: Partial<HouseholdMember> = {},
): HouseholdMember {
  return {
    id: `hm-${seq()}`,
    userId,
    householdId,
    showAllGames: true,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeGameCollection(
  userId: string,
  gameId: string,
  overrides: Partial<GameCollection> = {},
): GameCollection {
  return <GameCollection>{
    id: `gc-${seq()}`,
    userId,
    gameId,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  const n = seq();
  return {
    id: `job-${n}`,
    type: JobType.GameImport,
    status: JobStatus.Pending,
    initiatorType: InitiatorType.User,
    userId: null,
    gameId: null,
    batchId: null,
    bullmqJobId: null,
    payload: null,
    result: null,
    error: null,
    note: null,
    parentJobId: null,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeInvite(inviterId: string, overrides: Partial<Invite> = {}): Invite {
  const n = seq();
  return <Invite>{
    id: `invite-${n}`,
    inviterId,
    inviteeId: null,
    approvedById: null,
    roleId: null,
    inviteeEmail: null,
    token: `invite-token-${n}`,
    type: InviteType.Household,
    status: InviteStatus.Pending,
    householdId: null,
    eventId: null,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 48),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeEvent(householdId: string, createdById: string, overrides: Partial<Event> = {}): Event {
  const n = seq();
  return {
    id: `event-${n}`,
    householdId,
    createdById,
    title: `Event ${n}`,
    status: EventStatus.Planning,
    image: null,
    description: null,
    recurrenceRuleId: null,
    recurrenceStatus: null,
    schedulingMode: EventSchedulingMode.Fixed,
    location: null,
    url: null,
    type: EventType.CasualGathering,
    visibility: Visibility.Friends,
    deletedAt: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    averageRating: 8.6,
    bayesRating: null,
    complexity: 3.86,
    contentType: ContentType.BaseGame,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    createdById: null,
    deletedAt: null,
    description: null,
    enrichmentSource: null,
    frozenAt: null,
    id: 'game-fixture-1',
    image: null,
    maxPlayers: 4,
    maxPlayTime: 120,
    maxPlayTimeMeasure: TimeMeasure.Minutes,
    minAge: 14,
    minPlayers: 1,
    minPlayTime: 60,
    minPlayTimeMeasure: TimeMeasure.Minutes,
    ownedByCount: 0,
    playingTime: 120,
    publishYear: 2017,
    ratingsCount: null,
    subtitle: null,
    thumbnail: null,
    title: 'Gloomhaven',
    totalPlayCount: 0,
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    visibility: Visibility.Public,
    ...overrides,
  };
}

export function makeGameWithSource(overrides: Partial<GameWithSource> = {}): GameWithSource {
  const game = makeGame(overrides);
  return {
    ...game,
    gameSources: [{ sourceUrl: 'https://example.com/game' }],
    releases: [],
    platforms: [],
    ...overrides,
  };
}

interface GameWithSource extends Game {
  gameSources: { sourceUrl: string }[];
  releases: GameRelease[];
  platforms: Partial<Platform>[];
}
