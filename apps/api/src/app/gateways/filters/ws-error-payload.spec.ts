import { errorEnvelope } from '@bge/i18n';
import { WsConnectionRefusal, wsErrorPayload, wsExceptionPayload, type WsFrame } from './ws-error-payload';

describe('the WebSocket error envelope (#1260)', () => {
  const frame: WsFrame = { pattern: 'search:start', data: { correlationId: 'corr-1' } };

  it('fills the error envelope and the frame it answers', () => {
    expect(wsErrorPayload(404, 'm', frame)).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'm',
      pattern: 'search:start',
      correlationId: 'corr-1',
    });
  });

  it("sends a rendered envelope's fields beside the frame it answers (#1260)", () => {
    expect(wsExceptionPayload(errorEnvelope(409, 'm', { code: 'X' }), frame)).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'm',
      code: 'X',
      pattern: 'search:start',
      correlationId: 'corr-1',
    });
  });

  it("lets no envelope field contradict the frame's pattern and correlationId (#1260)", () => {
    const envelope = errorEnvelope(409, 'm', { pattern: 'other', correlationId: 'other', code: 'X' });

    expect(wsExceptionPayload(envelope, frame)).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'm',
      code: 'X',
      pattern: 'search:start',
      correlationId: 'corr-1',
    });
  });

  it("refuses a connection with a structured exception's code and no frame fields", () => {
    const refusal = new WsConnectionRefusal(503, 'm', { code: 'SESSION_UNAVAILABLE', error: 'Custom' });

    expect(refusal.data).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'm',
      code: 'SESSION_UNAVAILABLE',
    });
  });
});
