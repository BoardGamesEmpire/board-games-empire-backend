import { ExpressAdapter } from '@nestjs/platform-express';

/**
 * Nest's Express adapter, with its not-found handler mounted as Nest 11
 * mounted it: once, at the root, ahead of nothing but Express's own 404.
 *
 * Nest 12 mounts it under the global prefix instead, as a catch-all route
 * (`*path`), plus one route for each excluded path. That leaves two gaps:
 *
 * - A request outside `/api` that nothing serves, such as `/` on an api with
 *   no web client bundled, reaches no Nest handler, and Express answers it with
 *   an HTML page rather than the error envelope.
 * - A request the catch-all answers has `req.route` set, which is how
 *   `I18nExceptionFilter` tells that no route of the app's matched, so it would
 *   lose its `ROUTE_NOT_FOUND` code (#634).
 *
 * Mounted with `use()`, the handler runs for every request no route answered,
 * and leaves `req.route` unset, as before.
 */
export class ApiExpressAdapter extends ExpressAdapter {
  override setNotFoundHandler(handler: Parameters<ExpressAdapter['setNotFoundHandler']>[0]): void {
    this.use(handler);
  }
}
