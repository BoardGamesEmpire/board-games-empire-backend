import { connect as netConnect } from 'node:net';

/**
 * Writes a request byte for byte to the server at `baseUrl` and answers the
 * whole response, once the server ends the connection. For what `node:http`
 * and supertest won't send: a Host header with no value, none at all (#977),
 * or a request target they would rewrite, such as one with a `#` (#1511).
 *
 * The request must end the exchange itself, with `Connection: close` or as
 * HTTP/1.0, or this waits for the server's keep-alive timeout.
 */
export function rawExchange(baseUrl: string, raw: string): Promise<string> {
  const { hostname, port } = new URL(baseUrl);

  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: hostname, port: Number(port) }, () => socket.write(raw));
    let received = '';

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    socket.on('end', () => resolve(received));
    socket.on('error', reject);
  });
}
