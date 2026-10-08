import { driftDatabaseName, isProblemMessage } from './web-client';

describe('driftDatabaseName', () => {
  it("names the client's database for a server after the server's id", () => {
    expect(driftDatabaseName('568783cb-ff4a-4327-a0a7-f27355d8317a')).toBe(
      'bge_server_568783cb_ff4a_4327_a0a7_f27355d8317a',
    );
  });

  it('keeps letters, digits and underscores', () => {
    expect(driftDatabaseName('Server_01')).toBe('bge_server_Server_01');
  });
});

describe('isProblemMessage', () => {
  it('counts every console error', () => {
    expect(isProblemMessage('error', 'Failed to load resource: the server responded with a status of 404')).toBe(true);
  });

  it('counts a CSP refusal whatever its type', () => {
    const refusal =
      "Refused to compile or instantiate WebAssembly module because 'wasm-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\".";

    expect(isProblemMessage('warning', refusal)).toBe(true);
    expect(isProblemMessage('log', refusal)).toBe(true);
  });

  // The client logs through `print`, which reaches the console as a log.
  it("counts the client's own error lines, which arrive as logs", () => {
    expect(
      isProblemMessage(
        'log',
        '2026-10-08T08:25:30.950Z [ERROR] bge.shell.bootstrap: Bootstrap attempt failed {"attempt":1}',
      ),
    ).toBe(true);
  });

  it("passes the logs and warnings of a healthy load, headless Chromium's GPU warnings among them", () => {
    expect(isProblemMessage('debug', 'Injecting <script> tag. Using callback.')).toBe(false);
    expect(isProblemMessage('log', 'Got object store box in database hydrated_box.')).toBe(false);
    expect(
      isProblemMessage(
        'warning',
        '[.WebGL-0x12c0043a800]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels',
      ),
    ).toBe(false);
  });

  it("passes the client's warnings: only its errors fail a load", () => {
    expect(isProblemMessage('log', '2026-10-08T08:25:30.950Z [WARN] bge.network: HTTP server error response')).toBe(
      false,
    );
  });
});
