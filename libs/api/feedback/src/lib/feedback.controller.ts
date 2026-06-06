import { Action, ResourceType } from '@bge/database';
import { AppAbility, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, HttpCode, HttpStatus, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Http } from '@status/codes';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { from, map, Observable, tap } from 'rxjs';
import { FEEDBACK_THROTTLE_LIMIT, FEEDBACK_THROTTLE_TTL_SECONDS } from './constants/feedback.constants';
import { CreateFeedbackReportDto } from './dto/create-feedback-report.dto';
import { FeedbackReportDto } from './dto/feedback-report.dto';
import { FeedbackService } from './feedback.service';

interface SubmitFeedbackResponse {
  readonly message: string;
  readonly feedbackReport: FeedbackReportDto;
}

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('feedback')
@UseGuards(PoliciesGuard)
@Controller('feedback')
export class FeedbackController {
  private readonly logger = new Logger(FeedbackController.name);

  constructor(private readonly feedback: FeedbackService) {}

  @ApiOperation({ summary: 'Submit a feedback report (crash, bug, or feature request).' })
  @ApiResponse({ status: Http.Created, description: 'Feedback report submitted successfully' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Submission denied (insufficient permissions or feedback ban)' })
  @ApiResponse({ status: Http.TooManyRequests, description: 'Submission rate limit exceeded' })
  @CheckPolicies((ability: AppAbility) => ability.can(Action.create, ResourceType.FeedbackReport))
  @Throttle({ default: { limit: FEEDBACK_THROTTLE_LIMIT, ttl: FEEDBACK_THROTTLE_TTL_SECONDS } })
  @HttpCode(HttpStatus.CREATED)
  @Post('reports')
  submitReport(
    @Session() session: UserSession,
    @Body() dto: CreateFeedbackReportDto,
  ): Observable<SubmitFeedbackResponse> {
    return from(this.feedback.submit(session.user.id, dto)).pipe(
      tap((report) =>
        this.logger.log(
          `Feedback report ${report.id} (${report.category}/${report.context}) submitted by user ${session.user.id}`,
        ),
      ),
      map((report) => ({
        message: 'Feedback report submitted successfully',
        feedbackReport: FeedbackReportDto.fromEntity(report),
      })),
    );
  }
}
