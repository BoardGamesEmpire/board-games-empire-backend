import type { Span, SpanContext } from '@opentelemetry/api';
import type { LoggerOptions, TransportTargetOptions } from 'pino';

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

/**
 * Narrows the loose `LoggerOptions['transport']` to the multi-target
 * shape that {@link buildOtelPinoOptions} always produces. Lets every
 * assertion in this file address `targets` without `any` casts.
 */
const getTargets = (options: LoggerOptions): TransportTargetOptions[] => {
  const transport = options.transport;
  if (transport && typeof transport === 'object' && 'targets' in transport) {
    return transport.targets as TransportTargetOptions[];
  }
  throw new Error('expected transport to expose targets[]');
};

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
  describe('composition with @bge/logger base options', () => {
    it('preserves the pino-pretty target inherited from buildBasePinoOptions', () => {
      const targets = getTargets(buildOtelPinoOptions({}));

      expect(targets.some((t) => t.target === 'pino-pretty')).toBe(true);
    });

    it('inherits the resolved level from base options at the top level', () => {
      const options = buildOtelPinoOptions({ LOG_LEVEL: 'warn' });

      expect(options.level).toBe('warn');
    });
  });

  describe('OTel trace correlation', () => {
    it('always sets the trace correlation mixin', () => {
      const options = buildOtelPinoOptions({});

      expect(options.mixin).toBe(otelTraceMixin);
    });
  });

  describe('pino-opentelemetry-transport', () => {
    it('omits the OTLP transport target when OTEL_EXPORTER_OTLP_ENDPOINT is unset', () => {
      const targets = getTargets(buildOtelPinoOptions({}));

      expect(targets.some((t) => t.target === 'pino-opentelemetry-transport')).toBe(false);
    });

    it('appends pino-opentelemetry-transport when OTLP endpoint is set', () => {
      const targets = getTargets(buildOtelPinoOptions({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }));

      expect(targets.some((t) => t.target === 'pino-opentelemetry-transport')).toBe(true);
    });

    it('appends after the inherited base targets (does not replace them)', () => {
      const targets = getTargets(buildOtelPinoOptions({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }));

      expect(targets).toHaveLength(2);
      expect(targets[0].target).toBe('pino-pretty');
      expect(targets[1].target).toBe('pino-opentelemetry-transport');
    });

    it('forwards OTEL_RESOURCE_ATTRIBUTES into the transport options', () => {
      const targets = getTargets(
        buildOtelPinoOptions({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
          OTEL_RESOURCE_ATTRIBUTES: 'service.name=bge-api,service.version=1.0.0',
        }),
      );

      const otelTransport = targets.find((t) => t.target === 'pino-opentelemetry-transport');
      expect(otelTransport).toBeDefined();
      const transportOptions = otelTransport?.options as { resourceAttributes?: string };
      expect(transportOptions.resourceAttributes).toBe('service.name=bge-api,service.version=1.0.0');
    });

    it('applies the resolved level to the OTLP transport target', () => {
      const targets = getTargets(
        buildOtelPinoOptions({
          LOG_LEVEL: 'warn',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        }),
      );

      for (const target of targets) {
        expect(target.level).toBe('warn');
      }
    });
  });

  describe('env defaulting', () => {
    it('defaults env to process.env when no argument is supplied', () => {
      const originalEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

      try {
        const targets = getTargets(buildOtelPinoOptions());
        expect(targets).toHaveLength(1);
        expect(targets[0].target).toBe('pino-pretty');
      } finally {
        if (originalEndpoint !== undefined) {
          process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = originalEndpoint;
        }
      }
    });
  });
});
