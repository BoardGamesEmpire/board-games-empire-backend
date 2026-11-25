import type { ArgumentsHost, ExceptionFilter, INestApplication } from '@nestjs/common';
import { Catch, Controller, Get, HttpException, RequestMethod } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ApiExpressAdapter } from './api-express.adapter';

@Controller('games')
class GamesController {
  @Get()
  list(): string[] {
    return [];
  }
}

@Controller('health')
class HealthController {
  @Get()
  check(): string {
    return 'ok';
  }
}

/** Records whether Express had matched a route when the 404 reached the filters. */
const seen: { route: unknown }[] = [];

@Catch(HttpException)
class RouteRecordingFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<{ route?: unknown }>();
    seen.push({ route: request.route });
    host.switchToHttp().getResponse().status(exception.getStatus()).json({ status: exception.getStatus() });
  }
}

// Nest 12 mounts its not-found handler under the global prefix, as a route,
// which leaves a request outside the prefix to Express's HTML 404 and gives
// one inside it a `req.route`. I18nExceptionFilter reads an unset `req.route`
// as "no route matched" (#634).
describe('ApiExpressAdapter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GamesController, HealthController],
      providers: [{ provide: APP_FILTER, useClass: RouteRecordingFilter }],
    }).compile();

    app = moduleRef.createNestApplication(new ApiExpressAdapter(), { logger: false });
    app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
    await app.listen(0);
  });

  afterAll(() => app.close());

  beforeEach(() => {
    seen.length = 0;
  });

  it.each([
    ['inside the global prefix', 'GET', '/api/nothing'],
    ['outside the global prefix', 'GET', '/nothing'],
    ['at the root', 'GET', '/'],
    ['on an excluded path, with a method it lacks', 'POST', '/health'],
  ])('answers a request %s that no route matches through Nest, with no route set', async (_, method, path) => {
    const res = await fetch(`${await app.getUrl()}${path}`, { method });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ status: 404 });
    expect(seen).toEqual([{ route: undefined }]);
  });

  it('still serves the routes', async () => {
    const res = await fetch(`${await app.getUrl()}/api/games`);

    expect(res.status).toBe(200);
  });
});
