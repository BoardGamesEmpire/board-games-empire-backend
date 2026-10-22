import { SystemActorScope } from '@bge/actor-context';
import {
  DatabaseService,
  DataGatewayCapability,
  DataGatewayInterviewFailure,
  type DataGateway,
  type Prisma,
} from '@bge/database';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import type { GatewayPingResponse } from '@boardgamesempire/proto-gateway';
import { status } from '@grpc/grpc-js';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'node:crypto';
import type { Observable } from 'rxjs';
import { GatewayInterviewError } from './errors/gateway-interview.error';
import { GatewayCapabilitiesChangedEvent } from './events/gateway-registry.events';
import { firstAnswer } from './utils/first-answer';
import { toInterviewAnswers } from './utils/interview-answers';
import { VocabularySectionQueue } from './vocabulary-section.queue';

/** How old a DataGateway's answers may grow before it's interviewed again. */
export const INTERVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How many times an interview tries its conditional write before it fails.
 * Each miss means another process's interview stored first. The answers are
 * never stored without the condition, which would leave a change of
 * capabilities unrecorded.
 */
const STORE_ATTEMPTS = 5;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const sameList = <T>(left: readonly T[], right: readonly T[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/** A Describe the DataGateway doesn't implement, or one that failed in some other way. */
const describeFailure = (err: unknown): DataGatewayInterviewFailure =>
  (err as { code?: unknown } | null)?.code === status.UNIMPLEMENTED
    ? DataGatewayInterviewFailure.DescribeUnsupported
    : DataGatewayInterviewFailure.DescribeFailed;

type InterviewData = Prisma.DataGatewayUpdateManyMutationInput & { capabilities: DataGatewayCapability[] };

/**
 * What an interview read from the row and builds on: the capabilities it
 * records a change from, and whether the first interview was done. Its
 * answers are written only while the row still holds them.
 */
type StoredState = Pick<DataGateway, 'capabilities' | 'firstInterviewedAt'>;

/** The answers, with the first interview's time when the row as read has none. */
const withFirstInterview = (answers: InterviewData, before: StoredState, interviewedAt: Date): InterviewData =>
  before.firstInterviewedAt ? answers : { ...answers, firstInterviewedAt: interviewedAt };

/** An interview under way: the driver it asks through, and how to abandon it. */
interface InterviewAttempt {
  readonly driver: DataGatewayDriver;
  readonly abandonment: AbortController;
  readonly done: Promise<void>;
}

/**
 * A wait before an interview starts, a stale check's ping or the first
 * interview's look at the row, or a section run after one. The DataGateway
 * and driver it asks through, and how to abandon it.
 */
interface PendingStart {
  readonly gatewayId: string;
  readonly driver: DataGatewayDriver;
  readonly abandonment: AbortController;
}

/**
 * The interview: the server asking a DataGateway to describe itself, and
 * storing the answers on its row, where routing reads them (#712).
 *
 * An interview pings, for the DataGateway's version, then asks Describe.
 * Once it has stored the answers, it queues one list job for each list the
 * DataGateway declares and no admin switched off, and each job loads that
 * section of its vocabulary afterwards (#718). A section is best-effort: it
 * records its own outcome and holds the DataGateway back from nothing. It
 * runs through the driver its job resolves, abandoned with that driver's
 * interviews ({@link runSection}).
 *
 * A failed interview records a coarse code on the row, keeps the last good
 * answers in use, and throws. It never counts toward auto-disable: a
 * DataGateway that answers its ping isn't down, and re-enabling it couldn't
 * fix an interview.
 *
 * The first interview runs when the gateway registry connects a DataGateway,
 * before routing it. Later ones run in the background: on connect, and from
 * the hourly backstop, when the DataGateway reports a different version or
 * its answers are a day old, and on the first connect after its connection
 * changes ({@link refreshIfStale}); and when an admin asks. An interview or
 * stale check asking through a driver the gateway registry lets go of is
 * abandoned ({@link abandon}). A DataGateway an admin disabled or deleted isn't
 * interviewed, though the gateway worker may still hold its driver (dropping
 * that is #701's). An interview under way when that happens leaves the row
 * as it is. The coordinator and the gateway worker both host the gateway
 * registry, so either may interview, and a repeated interview just writes
 * the same answers and queues list jobs that fold into those waiting.
 */
@Injectable()
export class GatewayInterviewService {
  private readonly logger = new Logger(GatewayInterviewService.name);

  // Interviews under way in this process, by DataGateway, so callers that
  // want the same DataGateway interviewed at once share one interview.
  private readonly inFlight = new Map<string, InterviewAttempt>();

  // Stale checks under way, by driver, so a DataGateway that never answers is
  // left with one check waiting on it, not one more every hour, and so
  // abandon() can stop them.
  private readonly checks = new Map<DataGatewayDriver, PendingStart>();

  // First interviews still reading the row, so abandon() can stop one before
  // its interview starts.
  private readonly lookups = new Set<PendingStart>();

  // List jobs' sections under way, so abandon() can stop one writing links
  // once its connection is closed or replaced (#718).
  private readonly sections = new Set<PendingStart>();

  constructor(
    private readonly db: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly systemActorScope: SystemActorScope,
    private readonly sectionQueue: VocabularySectionQueue,
  ) {}

  /**
   * The first interview, unless the DataGateway's row shows it already: the
   * coordinator and the gateway worker both connect it, and whichever comes
   * second skips it. Throws when the interview fails, and when the gateway
   * registry lets go of the driver while the row is read ({@link abandon}).
   * Resolves to whether it interviewed.
   */
  async interviewUnlessDone(gatewayId: string, driver: DataGatewayDriver): Promise<boolean> {
    const lookup: PendingStart = { gatewayId, driver, abandonment: new AbortController() };
    this.lookups.add(lookup);
    try {
      const row = await this.db.dataGateway.findUnique({
        where: { id: gatewayId },
        select: { firstInterviewedAt: true },
      });

      if (row?.firstInterviewedAt) {
        return false;
      }

      lookup.abandonment.signal.throwIfAborted();
    } finally {
      this.lookups.delete(lookup);
    }

    await this.startOrJoin(gatewayId, driver);
    return true;
  }

  /** Interviews the DataGateway now, however recent its answers. Throws when the interview fails. */
  interview(gatewayId: string, driver: DataGatewayDriver): Promise<void> {
    return this.startOrJoin(gatewayId, driver);
  }

  /**
   * Runs one list job's section through `driver`, abandoned with the
   * driver's interviews ({@link abandon}): `section`'s signal aborts once the
   * gateway registry lets go of the driver, so it starts no further write
   * through a connection that was closed or replaced (#718).
   */
  async runSection<T>(
    gatewayId: string,
    driver: DataGatewayDriver,
    section: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const run: PendingStart = { gatewayId, driver, abandonment: new AbortController() };
    this.sections.add(run);
    try {
      return await section(run.abandonment.signal);
    } finally {
      this.sections.delete(run);
    }
  }

  /**
   * Abandons the DataGateway's interview, stale checks and section runs under
   * way, and a first interview still reading its row, or only those asking
   * through `driver`. The gateway registry calls this when it disposes a driver, and
   * when a config event invalidates the DataGateway. The interview stops
   * waiting on the DataGateway, starts no further write, and fails for its
   * callers, so it records no failure of a connection that was closed under
   * it. The next caller starts a new interview rather than joining it. A
   * stale check stops waiting on its ping, so a late answer starts no
   * interview through the driver, and a first interview reading the row
   * fails without starting.
   */
  abandon(gatewayId: string, driver?: DataGatewayDriver): void {
    const reason = new Error(
      `The interview of DataGateway ${gatewayId} was abandoned: its connection was closed or replaced`,
    );

    for (const pending of [...this.checks.values(), ...this.lookups, ...this.sections]) {
      if (pending.gatewayId === gatewayId && (!driver || pending.driver === driver)) {
        pending.abandonment.abort(reason);
      }
    }

    const attempt = this.inFlight.get(gatewayId);
    if (!attempt || (driver && attempt.driver !== driver)) {
      return;
    }

    this.inFlight.delete(gatewayId);
    attempt.abandonment.abort(reason);
  }

  /**
   * Pings the DataGateway, and interviews it again when its connection
   * changed since its answers were stored (`connectionChanged`), when it
   * reports a version other than the stored one, or when its answers are a
   * day old. One that reports no version is only re-interviewed for age, and
   * one an admin disabled or deleted is left alone. Never throws: a ping that
   * fails is only logged, and an interview that fails records itself. While
   * a check through the driver still waits, no other is started, and a check
   * through a driver the gateway registry lets go of stops ({@link abandon}).
   */
  async refreshIfStale(gatewayId: string, driver: DataGatewayDriver, connectionChanged = false): Promise<void> {
    if (this.checks.has(driver)) {
      this.logger.warn(`DataGateway ${gatewayId} hasn't answered its last stale check yet; not starting another`);
      return;
    }

    const check: PendingStart = { gatewayId, driver, abandonment: new AbortController() };
    const { signal } = check.abandonment;
    this.checks.set(driver, check);
    try {
      const row = await this.db.dataGateway.findUnique({
        where: { id: gatewayId },
        select: { enabled: true, deletedAt: true, gatewayVersion: true, lastInterviewedAt: true },
      });

      if (!row?.enabled || row.deletedAt) {
        return;
      }

      let ping: GatewayPingResponse;
      try {
        ping = await firstAnswer(driver.ping({ correlationId: crypto.randomUUID() }), signal);
      } catch (err) {
        // Abandoning the check isn't the DataGateway failing to answer.
        signal.throwIfAborted();
        // Not an interview, so the row records nothing, and not counted
        // toward auto-disable: whether it should be is #722's call.
        this.logger.warn(`DataGateway ${gatewayId} didn't answer the ping for a stale interview: ${errorMessage(err)}`);
        return;
      }

      const reason = connectionChanged ? 'its connection changed' : this.staleness(row, ping);
      if (reason) {
        // The driver may have been let go of after the ping answered.
        signal.throwIfAborted();
        this.logger.log(`Interviewing DataGateway ${gatewayId} again: ${reason}`);
        await this.startOrJoin(gatewayId, driver, ping);
      }
    } catch (err) {
      this.logger.warn(`Interviewing DataGateway ${gatewayId} again failed: ${errorMessage(err)}`);
    } finally {
      this.checks.delete(driver);
    }
  }

  private staleness(
    row: { gatewayVersion: string | null; lastInterviewedAt: Date | null },
    ping: GatewayPingResponse,
  ): string | null {
    const reported = ping.gatewayVersion?.trim();
    if (reported && reported !== row.gatewayVersion) {
      return `it reports version ${reported}, not ${row.gatewayVersion ?? 'none'}`;
    }

    if (!row.lastInterviewedAt || Date.now() - row.lastInterviewedAt.getTime() >= INTERVIEW_MAX_AGE_MS) {
      return 'its answers are a day old';
    }

    return null;
  }

  /** Starts an interview, or joins the one already under way for the DataGateway. */
  private startOrJoin(gatewayId: string, driver: DataGatewayDriver, ping?: GatewayPingResponse): Promise<void> {
    const inFlight = this.inFlight.get(gatewayId);
    if (inFlight) {
      return inFlight.done;
    }

    const abandonment = new AbortController();
    const attempt: InterviewAttempt = {
      driver,
      abandonment,
      done: this.conductInterview(gatewayId, driver, abandonment.signal, ping).finally(() => {
        // An abandoned interview's slot may hold its successor by now.
        if (this.inFlight.get(gatewayId) === attempt) {
          this.inFlight.delete(gatewayId);
        }
      }),
    };

    this.inFlight.set(gatewayId, attempt);
    return attempt.done;
  }

  /**
   * One interview, which stops at the next question or write once `signal`
   * aborts. `knownPing` is a ping the caller has just made, so it isn't asked
   * twice.
   */
  private async conductInterview(
    gatewayId: string,
    driver: DataGatewayDriver,
    signal: AbortSignal,
    knownPing?: GatewayPingResponse,
  ): Promise<void> {
    const initiatedAt = new Date();
    const row = await this.db.dataGateway.findUnique({
      where: { id: gatewayId },
      select: {
        enabled: true,
        deletedAt: true,
        capabilities: true,
        disabledCapabilities: true,
        firstInterviewedAt: true,
      },
    });

    if (!row || row.deletedAt) {
      throw new Error(`DataGateway ${gatewayId} doesn't exist, or was deleted; it isn't interviewed`);
    }

    if (!row.enabled) {
      throw new Error(`DataGateway ${gatewayId} is disabled; it isn't interviewed`);
    }

    // Ping first: Describe doesn't repeat the DataGateway's version.
    const ping =
      knownPing ??
      (await this.ask(
        gatewayId,
        signal,
        () => driver.ping({ correlationId: crypto.randomUUID() }),
        () => DataGatewayInterviewFailure.PingFailed,
      ));
    const description = await this.ask(
      gatewayId,
      signal,
      () => driver.describe({ correlationId: crypto.randomUUID() }),
      describeFailure,
    );
    const answers = toInterviewAnswers(description, ping);

    const interviewedAt = new Date();
    await this.store(gatewayId, row, initiatedAt, interviewedAt, signal, {
      ...answers,
      lastInterviewedAt: interviewedAt,
    });

    this.logger.log(`Interviewed DataGateway ${gatewayId}`);

    // Its sections load afterwards, each its own list job (#718). Not
    // awaited: queueing is best-effort and never rejects, and a queue that
    // hangs, as when its Redis is unreachable, mustn't hold back the
    // interview, nor the first connect that waits on it.
    void this.sectionQueue.enqueue(gatewayId, answers.capabilities, row.disabledCapabilities);
  }

  /**
   * One question the interview can't go on without. When it fails, the row
   * records why and keeps its last good answers, and the interview throws.
   * An abandoned interview records nothing, nor does one whose DataGateway
   * an admin disabled or deleted meanwhile.
   */
  private async ask<T>(
    gatewayId: string,
    signal: AbortSignal,
    call: () => Observable<T>,
    failure: (err: unknown) => DataGatewayInterviewFailure,
  ): Promise<T> {
    try {
      return await firstAnswer(call(), signal);
    } catch (err) {
      signal.throwIfAborted();
      const code = failure(err);
      this.logger.warn(`The interview of DataGateway ${gatewayId} failed (${code}): ${errorMessage(err)}`);
      await this.recordFailure(gatewayId, code);
      throw new GatewayInterviewError(gatewayId, code, err);
    }
  }

  private async recordFailure(gatewayId: string, failure: DataGatewayInterviewFailure): Promise<void> {
    try {
      // A row an admin disabled or deleted meanwhile is left as it is, as
      // when the answers are stored.
      await this.db.dataGateway.updateMany({
        where: { id: gatewayId, enabled: true, deletedAt: null },
        data: { lastInterviewFailedAt: new Date(), lastInterviewFailure: failure },
      });
    } catch (err) {
      this.logger.warn(`Couldn't record DataGateway ${gatewayId}'s failed interview: ${errorMessage(err)}`);
    }
  }

  /**
   * Stores the answers, on condition that the row still holds what the
   * interview read: its capabilities, and no first interview if it read
   * none. So the first interview's time is written once, and a change of
   * capabilities is recorded by the one write that makes it, as auto-disable
   * records its change of `enabled`: when the coordinator and the gateway
   * worker both interview, the change is recorded once. A write that misses
   * has met another process's interview: it's tried again over what that one
   * stored, so a change between their answers is recorded too, even when this
   * interview's answers match what it read. After {@link STORE_ATTEMPTS}
   * misses the interview fails, and the row keeps what the other processes
   * stored. An abandoned interview stops before its next try.
   *
   * The row must also still be enabled and not deleted. An admin who
   * disables a DataGateway leaves its connection as it was, so the interview
   * under way isn't abandoned (#701): it fails here instead, and stores no
   * answers.
   * `disabledCapabilities` is never written here, so an admin's switch-off
   * outlasts every interview.
   */
  private async store(
    gatewayId: string,
    read: StoredState,
    initiatedAt: Date,
    interviewedAt: Date,
    signal: AbortSignal,
    answers: InterviewData,
  ): Promise<void> {
    let before = read;

    for (let attempt = 0; attempt < STORE_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      if (await this.storeOver(gatewayId, before, initiatedAt, withFirstInterview(answers, before, interviewedAt))) {
        return;
      }

      const current = await this.db.dataGateway.findUnique({
        where: { id: gatewayId },
        select: { enabled: true, deletedAt: true, capabilities: true, firstInterviewedAt: true },
      });
      if (!current?.enabled || current.deletedAt) {
        throw new Error(
          `DataGateway ${gatewayId} was disabled or deleted during its interview; its answers weren't stored`,
        );
      }
      before = current;
    }

    throw new Error(`DataGateway ${gatewayId}'s row kept changing under its interview; its answers weren't stored`);
  }

  /**
   * Writes the answers on condition that the row still holds `before`, and
   * emits the change of capabilities, if there is one, when the write lands.
   * Resolves to whether it landed.
   */
  private storeOver(gatewayId: string, before: StoredState, initiatedAt: Date, data: InterviewData): Promise<boolean> {
    // A change it records is the system's doing, whoever's request reached
    // the DataGateway first.
    return this.systemActorScope.run('gateway-registry:interview', async () => {
      const written = await this.db.dataGateway.updateMany({
        where: {
          id: gatewayId,
          enabled: true,
          deletedAt: null,
          capabilities: { equals: before.capabilities },
          ...(before.firstInterviewedAt === null && { firstInterviewedAt: null }),
        },
        data,
      });

      if (written.count === 0) {
        return false;
      }

      const after = data.capabilities;
      if (!sameList(before.capabilities, after)) {
        this.eventEmitter.emit(
          GatewayCapabilitiesChangedEvent.eventName,
          new GatewayCapabilitiesChangedEvent(
            { id: gatewayId, capabilities: before.capabilities },
            { id: gatewayId, capabilities: after },
            initiatedAt,
          ),
        );
        this.logger.log(
          `DataGateway ${gatewayId}'s capabilities changed: [${before.capabilities.join(', ')}] → [${after.join(', ')}]`,
        );
      }

      return true;
    });
  }
}
