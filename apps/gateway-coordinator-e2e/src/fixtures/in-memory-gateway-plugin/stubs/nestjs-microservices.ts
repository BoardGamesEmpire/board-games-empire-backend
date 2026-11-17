/**
 * Stands in for `@nestjs/microservices` when the fixture plugin is bundled.
 * The generated gateway protos import its gRPC decorators for the controllers
 * a NestJS server mounts, and the plugin mounts none: it reaches that code
 * only for the proto enums. A plugin carries everything it runs, so the real
 * package, and the NestJS it requires, would otherwise be bundled whole.
 *
 * Each export here is one the generated code imports. esbuild fails the
 * build on an import this file doesn't export, which is the cue to add it.
 */
const noDecorator = (): MethodDecorator => () => undefined;

export const GrpcMethod = noDecorator;
export const GrpcStreamMethod = noDecorator;
