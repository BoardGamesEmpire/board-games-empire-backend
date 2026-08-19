import {
  Action,
  DeploymentRuntime,
  FeedbackCategory,
  FeedbackContext,
  FeedbackSeverity,
  FeedbackStatus,
  ResourceType,
  type FeedbackReport,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AppAbility, CHECK_POLICIES_KEY, PoliciesGuard } from '@bge/permissions';
import { Test, TestingModule } from '@nestjs/testing';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { firstValueFrom } from 'rxjs';
import { CreateFeedbackReportDto } from './dto/create-feedback-report.dto';
import { FeedbackReceiptDto } from './dto/feedback-receipt.dto';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

describe('FeedbackController', () => {
  let controller: FeedbackController;
  let feedback: jest.Mocked<Pick<FeedbackService, 'submit'>>;

  beforeEach(async () => {
    feedback = { submit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeedbackController],
      providers: [{ provide: FeedbackService, useValue: feedback }],
    })
      .overrideGuard(PoliciesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(FeedbackController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /api/feedback/reports', () => {
    it('forwards the authenticated user id and dto to FeedbackService.submit', async () => {
      const created = stubReport({ id: 'fb-controller-1', userId: 'user-42' });
      feedback.submit.mockResolvedValue(created);

      const result = await firstValueFrom(controller.submitReport(stubSession('user-42'), makeDto()));

      expect(feedback.submit).toHaveBeenCalledWith('user-42', expect.objectContaining({ message: 'Crash on load' }));
      expect(result.feedbackReport.id).toBe('fb-controller-1');
      expect(result.message).toEqual(t('success.feedback.submitted'));
    });

    it('returns a minimal receipt (id + createdAt) and leaks no other report state', async () => {
      const createdAt = new Date('2026-07-20T00:00:00.000Z');
      const created = stubReport({
        id: 'fb-shape-1',
        createdAt,
        category: FeedbackCategory.FeatureRequest,
        deploymentRuntime: DeploymentRuntime.Kubernetes,
        deploymentVersion: '0.4.1',
        userRedactedFields: ['email'],
        redactionApplied: true,
      });
      feedback.submit.mockResolvedValue(created);

      const result = await firstValueFrom(
        controller.submitReport(stubSession('user-1'), makeDto({ category: FeedbackCategory.FeatureRequest })),
      );

      expect(result.feedbackReport).toBeInstanceOf(FeedbackReceiptDto);
      // Exactly { id, createdAt } — no status, redaction flags, deployment
      // snapshot, or message must ride along on the submit response.
      expect({ ...result.feedbackReport }).toEqual({ id: 'fb-shape-1', createdAt });
    });

    it('propagates service errors unchanged', async () => {
      const error = new Error('Database connection lost');
      feedback.submit.mockRejectedValue(error);

      await expect(firstValueFrom(controller.submitReport(stubSession('user-1'), makeDto()))).rejects.toBe(error);
    });
  });

  describe('decorator metadata', () => {
    it('attaches PoliciesGuard at the class level', () => {
      const guards = Reflect.getMetadata('__guards__', FeedbackController) as unknown[] | undefined;

      expect(Array.isArray(guards)).toBe(true);
      expect(guards?.length).toBeGreaterThan(0);
    });

    it('declares a CASL policy requiring create:FeedbackReport', () => {
      const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, controller.submitReport) as
        | Array<(ability: AppAbility) => boolean>
        | undefined;

      expect(handlers).toBeDefined();
      expect(handlers?.length).toBeGreaterThan(0);

      const ability = {
        can: jest.fn().mockReturnValue(true),
      } as unknown as AppAbility;

      handlers?.[0](ability);

      expect(ability.can).toHaveBeenCalledWith(Action.create, ResourceType.FeedbackReport);
    });

    // Throttle decorator correctness lives in `throttling/feedback-throttler.spec.ts`,
    // which does read `@nestjs/throttler`'s metadata keys. This comment used to
    // say that was deliberately avoided in favour of an integration test against
    // a real Redis storage — there is no such test, and no Redis storage is wired
    // into ThrottlerModule at all. The coupling was worth accepting: without it
    // nothing caught the tier shipping a 3.6-second window for a policy
    // documented as hourly (#293).
  });
});

function makeDto(overrides: Partial<CreateFeedbackReportDto> = {}): CreateFeedbackReportDto {
  return {
    category: FeedbackCategory.Bug,
    message: 'Crash on load',
    severity: FeedbackSeverity.High,
    ...overrides,
  } as CreateFeedbackReportDto;
}

function stubSession(userId: string): UserSession {
  return { user: { id: userId } } as UserSession;
}

function stubReport(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  const now = new Date();

  return {
    id: 'fb-1',
    message: 'Crash on load',
    title: null,
    category: FeedbackCategory.Bug,
    context: FeedbackContext.Unknown,
    severity: FeedbackSeverity.High,
    appVersion: null,
    platform: null,
    locale: null,
    deviceInfo: null,
    deploymentRuntime: DeploymentRuntime.StandaloneNode,
    deploymentVersion: null,
    userId: 'user-1',
    clientRequestId: null,
    userRedactedFields: [],
    redactionApplied: false,
    serverRedacted: false,
    status: FeedbackStatus.New,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as FeedbackReport;
}
