import {
  DatabaseService,
  Event,
  EventParticipationStatus,
  EventSchedulingMode,
  EventStatus,
  isPrismaDependentRecordNotFoundError,
  OccurrenceStatus,
  SystemRole,
} from '@bge/database';
import type { AppAbility } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { accessibleBy, WhereInput } from '@casl/prisma';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { EventEvents } from './constants/event-events.constant';
import type { CreateEventDto } from './dto/create-event.dto';
import type { UpdateEventDto } from './dto/update-event.dto';
import type { EventCreatedEvent, EventDeletedEvent } from './interfaces/event.interface';

@Injectable()
export class EventService {
  private readonly logger = new Logger(EventService.name);

  constructor(private readonly db: DatabaseService, private readonly eventEmitter: EventEmitter2) {}

  async getEvents(pagination: PaginationQueryDto, abilities: AppAbility[]): Promise<Event[]> {
    return this.db.event.findMany({
      where: {
        deletedAt: null,
        AND: this.createEventWhereAnd(abilities),
      },
      include: {
        occurrences: {
          orderBy: { sortOrder: 'asc' },
        },
        policy: true,
      },
      skip: pagination.offset,
      take: pagination.limit || 20,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getEventById(id: string, abilities: AppAbility[]): Promise<Event> {
    const event = await this.db.event.findUnique({
      where: {
        id,
        deletedAt: null,
        AND: this.createEventWhereAnd(abilities),
      },

      include: {
        occurrences: {
          orderBy: { sortOrder: 'asc' },
        },

        attendees: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                profile: {
                  select: {
                    avatarUrl: true,
                    displayName: true,
                  },
                },
              },
            },

            role: {
              include: {
                role: {
                  select: { id: true, name: true },
                },
              },
            },
          },
        },
        policy: true,
      },
    });

    assert(event, new NotFoundException(`Event with ID ${id} not found`));
    return event;
  }

  async createEvent(userId: string, dto: CreateEventDto): Promise<Event> {
    const { occurrences, policy, householdId, inviteUserIds = [], ...eventFields } = dto;

    this.validateOccurrencesForMode(dto.schedulingMode ?? EventSchedulingMode.Fixed, occurrences);
    const uniqueInviteIds = Array.from(new Set(inviteUserIds.filter((id) => id !== userId)));

    const event = await this.db.$transaction(async (tx) => {
      const created = await tx.event.create({
        data: {
          ...eventFields,

          household: householdId ? { connect: { id: householdId } } : undefined,
          status: dto.schedulingMode === EventSchedulingMode.Poll ? EventStatus.Planning : EventStatus.Scheduled,

          createdBy: { connect: { id: userId } },

          occurrences:
            occurrences && occurrences.length > 0
              ? {
                  create: occurrences.map((occ, idx) => ({
                    label: occ.label,
                    startDate: occ.startDate,
                    endDate: occ.endDate,
                    location: occ.location,
                    sortOrder: occ.sortOrder ?? idx,
                    policy: dto.schedulingMode === EventSchedulingMode.Poll ? undefined : { create: {} },
                    status:
                      dto.schedulingMode === EventSchedulingMode.Poll
                        ? OccurrenceStatus.Proposed
                        : OccurrenceStatus.Confirmed,
                    confirmedAt: dto.schedulingMode === EventSchedulingMode.Poll ? null : new Date(),
                  })),
                }
              : undefined,

          policy: {
            create: policy
              ? {
                  allowMemberInvites: policy.allowMemberInvites,
                  allowGuestInvites: policy.allowGuestInvites,
                  maxAttendees: policy.maxAttendees,
                  requireHostApprovalToJoin: policy.requireHostApprovalToJoin,
                  allowSpectators: policy.allowSpectators,
                  maxTotalParticipants: policy.maxTotalParticipants,
                  strictCapacity: policy.strictCapacity,
                  gameAdditionMode: policy.gameAdditionMode,
                  restrictToAttendeePool: policy.restrictToAttendeePool,
                  restrictToGameCategories: policy.restrictToGameCategories,
                  fillerMaxPlayTime: policy.fillerMaxPlayTime,
                  voteThresholdType: policy.voteThresholdType,
                  voteThresholdValue: policy.voteThresholdValue,
                  voteQuorumType: policy.voteQuorumType,
                  voteQuorumValue: policy.voteQuorumValue,
                  voteEligibility: policy.voteEligibility,
                  interestedWeight: policy.interestedWeight,
                  votingWindowHours: policy.votingWindowHours,
                  ...(policy.allowedCategoryIds?.length
                    ? {
                        allowedCategories: {
                          create: policy.allowedCategoryIds.map((catId) => ({
                            category: { connect: { id: catId } },
                          })),
                        },
                      }
                    : {}),
                  // always create an event policy -- even an empty one
                }
              : {},
          },

          attendees: {
            create: [
              // Creator is automatically added as EventOrganizer attendee
              {
                user: { connect: { id: userId } },
                status: EventParticipationStatus.Attending,
                role: {
                  create: {
                    role: { connect: { name: SystemRole.EventHost } },
                  },
                },
              },
              ...uniqueInviteIds.map((inviteId) => ({
                user: { connect: { id: inviteId } },
                status: EventParticipationStatus.Invited,
                role: {
                  create: {
                    role: { connect: { name: SystemRole.EventParticipant } },
                  },
                },
              })),
            ],
          },
        },

        include: {
          occurrences: { orderBy: { sortOrder: 'asc' } },
          policy: true,
          attendees: {
            include: {
              role: {
                include: {
                  role: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      });

      return created;
    });

    this.eventEmitter.emit(EventEvents.EventCreated, {
      eventId: event.id,
      createdById: userId,
      householdId: householdId ?? null,
      invitedUserIds: uniqueInviteIds,
      title: event.title,
    } satisfies EventCreatedEvent);

    return event;
  }

  async updateEvent(id: string, dto: UpdateEventDto, abilities: AppAbility[]): Promise<Event> {
    assert(Object.keys(dto).length > 0, new BadRequestException('At least one field must be provided for update'));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { occurrences: _occurrences, policy: _policy, inviteUserIds: _inviteUserIds, householdId, ...fields } = dto;

    try {
      const existing = await this.db.event.count({
        where: { id, deletedAt: null },
      });
      assert(existing > 0, new NotFoundException(`Event with ID ${id} not found`));

      let householdRelation: { connect: { id: string } } | { disconnect: true } | undefined;
      if (householdId === null) {
        householdRelation = { disconnect: true };
      } else if (typeof householdId === 'string') {
        householdRelation = { connect: { id: householdId } };
      }

      return await this.db.event.update({
        where: {
          id,
          AND: this.createEventWhereAnd(abilities),
        },
        data: {
          ...fields,
          household: householdRelation,
        },
        include: {
          occurrences: { orderBy: { sortOrder: 'asc' } },
          policy: true,
        },
      });
    } catch (error) {
      this.logger.error(`Error updating event with ID ${id}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException("You don't have permission to update this resource.");
      }

      throw error;
    }
  }

  async deleteEvent(id: string, userId: string, abilities: AppAbility[]): Promise<Event> {
    try {
      const existing = await this.db.event.count({
        where: { id, deletedAt: null },
      });
      assert(existing > 0, new NotFoundException(`Event with ID ${id} not found`));

      const event = await this.db.event.update({
        where: {
          id,
          AND: this.createEventWhereAnd(abilities),
        },
        data: { deletedAt: new Date() },
      });

      this.eventEmitter.emit(EventEvents.EventDeleted, {
        eventId: id,
        deletedById: userId,
      } satisfies EventDeletedEvent);

      return event;
    } catch (error) {
      this.logger.error(`Error deleting event with ID ${id}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException("You don't have permission to delete this resource.");
      }

      throw error;
    }
  }

  private validateOccurrencesForMode(mode: EventSchedulingMode, occurrences?: CreateEventDto['occurrences']): void {
    if (mode === EventSchedulingMode.Fixed && occurrences && occurrences.length > 1) {
      throw new BadRequestException('Fixed scheduling mode allows at most one occurrence.');
    }
  }

  private createEventWhereAnd(abilities: AppAbility[]): WhereInput<Event>[] {
    assert(abilities.length > 0, new ForbiddenException("You don't have permission to access this resource"));

    const whereAnd: WhereInput<Event>[] = [];

    try {
      for (const ability of abilities) {
        if (ability) {
          whereAnd.push(accessibleBy(ability).Event);
        }
      }
    } catch (error) {
      this.logger.error('Error creating where conditions for event access control', error);
      throw new ForbiddenException("You don't have permission to access this resource.");
    }

    return whereAnd;
  }
}
