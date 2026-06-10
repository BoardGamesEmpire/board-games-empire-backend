import type { Span, SpanContext } from '@opentelemetry/api';

jest.mock('@opentelemetry/api', () => {
  const actual = jest.requireActual<typeof import('@opentelemetry/api')>('@opentelemetry/api');
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getSpan: jest.fn(),
    },
    context: {
      ...actual.context,
      active: jest.fn(() => ({})),
    },
  };
});

import { trace } from '@opentelemetry/api';
import { buildOtelPinoOptions, otelTraceMixin } from './otel-pino.options';

const getSpanMock = trace.getSpan as jest.Mock;

const buildSpanContext = (overrides: Partial<SpanContext> = {}): SpanContext => ({
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  traceFlags: 0x01,
  isRemote: false,
  ...overrides,
});

const buildSpan = (spanContext: SpanContext): Span => ({ spanContext: () => spanContext }) as Span;

describe('otelTraceMixin', () => {
  beforeEach(() => {
    getSpanMock.mockReset();
  });

  it('returns empty object when no active span', () => {
    getSpanMock.mockReturnValue(undefined);

    expect(otelTraceMixin()).toEqual({});
  });

  it('emits trace_id, span_id, and trace_flags when a span is active', () => {
    getSpanMock.mockReturnValue(buildSpan(buildSpanContext()));

    expect(otelTraceMixin()).toEqual({
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      trace_flags: '01',
    });
  });

  it('zero-pads trace_flags to two hex characters', () => {
    getSpanMock.mockReturnValue(buildSpan(buildSpanContext({ traceFlags: 0x00 })));

    expect(otelTraceMixin().trace_flags).toBe('00');
  });

  it('renders the full trace_flags byte (0xff)', () => {
    getSpanMock.mockReturnValue(buildSpan(buildSpanContext({ traceFlags: 0xff })));

    expect(otelTraceMixin().trace_flags).toBe('ff');
  });
});

describe('buildOtelPinoOptions', () => {
  it('always sets the trace correlation mixin', () => {
    const options = buildOtelPinoOptions({});

    expect(options.mixin).toBe(otelTraceMixin);
  });

  it('always configures at least one transport target', () => {
    const options = buildOtelPinoOptions({});

    expect((options.transport as { targets: unknown[] }).targets).toHaveLength(1);
  });

  it('configures pino-opentelemetry-transport when OTLP endpoint is set', () => {
    const options = buildOtelPinoOptions({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    });

    const targets = (options.transport as { targets: { target: string; options: unknown }[] }).targets;
    expect(targets.some((t) => t.target === 'pino-opentelemetry-transport')).toBe(true);
  });

  it('forwards OTEL_RESOURCE_ATTRIBUTES into the transport options', () => {
    const options = buildOtelPinoOptions({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_RESOURCE_ATTRIBUTES: 'service.name=bge-api,service.version=1.0.0',
    });

    const targets = (options.transport as { targets: { target: string; options: { resourceAttributes?: string } }[] })
      .targets;
    const otelTransport = targets.find((t) => t.target === 'pino-opentelemetry-transport');
    expect(otelTransport).toBeDefined();
    expect(otelTransport!.options.resourceAttributes).toBe('service.name=bge-api,service.version=1.0.0');
  });

  it('defaults env to process.env when no argument is supplied', () => {
    const originalEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

    try {
      const options = buildOtelPinoOptions();
      const targets = (options.transport as { targets: unknown[] }).targets;
      expect(targets).toHaveLength(1);
    } finally {
      if (originalEndpoint !== undefined) {
        process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = originalEndpoint;
      }
    }
  });
});
