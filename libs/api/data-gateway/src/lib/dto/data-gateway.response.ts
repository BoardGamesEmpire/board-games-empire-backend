import {
  AuthType,
  ContentFormat,
  ContentType,
  CoverageAxis,
  DataGatewayCapability,
  DataGatewayInterviewFailure,
  LanguageCodeFormat,
  PlatformType,
} from '@bge/database';
import { ApiProperty } from '@nestjs/swagger';
import type {
  DataGatewayInterviewFailureView,
  DataGatewayInterviewStatus,
  DataGatewayView,
} from '../data-gateway.view';

/**
 * OpenAPI models for a DataGateway row as the admin routes return it (#402,
 * #715). Each class `implements` the runtime shape from `data-gateway.view.ts`,
 * so a field added to the view and left out here is a compile error, not a
 * silent gap in the generated client.
 */

class DataGatewayInterviewFailureDto implements DataGatewayInterviewFailureView {
  @ApiProperty({ enum: DataGatewayInterviewFailure, enumName: 'DataGatewayInterviewFailure' })
  code!: DataGatewayInterviewFailure;

  @ApiProperty()
  at!: Date;
}

class DataGatewayInterviewStatusDto implements DataGatewayInterviewStatus {
  @ApiProperty({ description: "Whether an interview has ever succeeded. The DataGateway isn't used until one has." })
  interviewed!: boolean;

  @ApiProperty({ type: Date, nullable: true })
  firstInterviewedAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true, description: 'The last interview that succeeded' })
  lastInterviewedAt!: Date | null;

  @ApiProperty({
    type: DataGatewayInterviewFailureDto,
    nullable: true,
    description:
      'The last failure, only while it is current: null once a later interview succeeded. The raw error is ' +
      'only logged.',
  })
  failure!: DataGatewayInterviewFailureDto | null;
}

export class DataGatewayResponseDto implements DataGatewayView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  messageContext!: string | null;

  @ApiProperty({ type: String, nullable: true })
  iconUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  websiteUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  apiBaseUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  apiDocumentation!: string | null;

  @ApiProperty({ type: String, nullable: true })
  apiVersion!: string | null;

  @ApiProperty()
  connectionUrl!: string;

  @ApiProperty()
  connectionPort!: number;

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ enum: AuthType, enumName: 'AuthType' })
  authType!: AuthType;

  @ApiProperty({
    description: 'Whether credentials are stored. The credentials themselves are never returned (#753).',
  })
  hasAuthParameters!: boolean;

  @ApiProperty()
  usageCount!: number;

  @ApiProperty({ type: Date, nullable: true })
  lastUsed!: Date | null;

  @ApiProperty({
    enum: DataGatewayCapability,
    enumName: 'DataGatewayCapability',
    isArray: true,
    description: 'What the DataGateway declared at its last interview',
  })
  capabilities!: DataGatewayCapability[];

  @ApiProperty({ enum: PlatformType, enumName: 'PlatformType', isArray: true })
  coveragePlatformTypes!: PlatformType[];

  @ApiProperty({ enum: ContentType, enumName: 'ContentType', isArray: true })
  coverageContentTypes!: ContentType[];

  @ApiProperty({ enum: CoverageAxis, enumName: 'CoverageAxis', isArray: true })
  filterableAxes!: CoverageAxis[];

  @ApiProperty({
    enum: LanguageCodeFormat,
    enumName: 'LanguageCodeFormat',
    isArray: true,
    description: "In the DataGateway's order, most preferred first",
  })
  acceptedLanguageCodeFormats!: LanguageCodeFormat[];

  @ApiProperty({ enum: LanguageCodeFormat, enumName: 'LanguageCodeFormat', nullable: true })
  responseLanguageCodeFormat!: LanguageCodeFormat | null;

  @ApiProperty({ type: Boolean, nullable: true })
  passthroughSearchLanguage!: boolean | null;

  @ApiProperty({ enum: ContentFormat, enumName: 'ContentFormat', nullable: true })
  contentFormat!: ContentFormat | null;

  @ApiProperty({ type: String, nullable: true, description: 'The version it reported at its last interview' })
  gatewayVersion!: string | null;

  @ApiProperty({
    enum: DataGatewayCapability,
    enumName: 'DataGatewayCapability',
    isArray: true,
    description: "Capabilities an admin switched off. The server doesn't route them, and no interview changes this.",
  })
  disabledCapabilities!: DataGatewayCapability[];

  @ApiProperty({ type: Date, nullable: true })
  firstInterviewedAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  lastInterviewedAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true, description: 'Kept after a later success; read `interview.failure`' })
  lastInterviewFailedAt!: Date | null;

  @ApiProperty({
    enum: DataGatewayInterviewFailure,
    enumName: 'DataGatewayInterviewFailure',
    nullable: true,
    description: 'Kept after a later success; read `interview.failure`',
  })
  lastInterviewFailure!: DataGatewayInterviewFailure | null;

  @ApiProperty({ type: DataGatewayInterviewStatusDto })
  interview!: DataGatewayInterviewStatusDto;

  @ApiProperty({ type: String, nullable: true })
  createdById!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  deletedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

/** The by-id read's body: the row under `dataGateway`. */
export class DataGatewayEnvelopeDto {
  @ApiProperty({ type: DataGatewayResponseDto })
  dataGateway!: DataGatewayResponseDto;
}

/** The coordinator's answer as a client sees it. A failure carries translated copy, never the coordinator's error. */
export class GatewayCallAnswerDto {
  @ApiProperty()
  success!: boolean;

  @ApiProperty({ required: false, description: 'Present on a failure: a generic, translated message' })
  message?: string;
}

/** Create, update with `enabled: true`, and connect: the row plus the coordinator's connect answer. */
export class DataGatewayConnectAnswerDto extends DataGatewayEnvelopeDto {
  @ApiProperty({ description: 'False when no connect was asked for, such as a DataGateway created disabled' })
  connection_attempt!: boolean;

  @ApiProperty({ type: GatewayCallAnswerDto, nullable: true })
  connection_response!: GatewayCallAnswerDto | null;
}

/** Delete, update with `enabled: false`, and disconnect: the row plus the coordinator's disconnect answer. */
export class DataGatewayDisconnectAnswerDto extends DataGatewayEnvelopeDto {
  @ApiProperty({ description: 'False when no disconnect was asked for, such as deleting a disabled DataGateway' })
  disconnection_attempt!: boolean;

  @ApiProperty({ type: GatewayCallAnswerDto, nullable: true })
  disconnection_response!: GatewayCallAnswerDto | null;
}

/** The re-interview's answer: the row read again after the interview, and how the interview went (#715). */
export class DataGatewayInterviewAnswerDto extends DataGatewayEnvelopeDto {
  @ApiProperty({ enum: [true], description: 'Always true: the route answers 404 or 409 when it asks for nothing' })
  interview_attempt!: true;

  @ApiProperty({ type: GatewayCallAnswerDto })
  interview_response!: GatewayCallAnswerDto;
}
