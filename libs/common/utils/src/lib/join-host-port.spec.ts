import { joinHostPort } from './join-host-port.js';

describe('joinHostPort', () => {
  it.each([
    ['0.0.0.0', 50051, '0.0.0.0:50051'],
    ['coordinator', 50051, 'coordinator:50051'],
    ['localhost', 50052, 'localhost:50052'],
  ])('joins %s and %i as they are', (host, port, address) => {
    expect(joinHostPort(host, port)).toBe(address);
  });

  // Unbracketed, gRPC reads every colon as part of the host, and so finds no
  // port: `:::50051` is not port 50051 on `::`.
  it.each([
    ['::', 50051, '[::]:50051'],
    ['::1', 50052, '[::1]:50052'],
    ['fd00::2', 50051, '[fd00::2]:50051'],
  ])('brackets the IPv6 address %s', (host, port, address) => {
    expect(joinHostPort(host, port)).toBe(address);
  });
});
