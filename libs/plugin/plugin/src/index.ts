export * from './lib/config/plugin-config-events.service';
export * from './lib/config/plugin-config.constants';
export * from './lib/config/plugin-config.service';
export * from './lib/context/plugin-context';
export * from './lib/context/plugin-context.factory';
export * from './lib/events/constants';
export * from './lib/events/plugin-lifecycle-event-type.map';
export * from './lib/events/plugin.events';
export * from './lib/grants/grant.errors';
export * from './lib/grants/plugin-admin-permissions';
export * from './lib/grants/plugin-grant-authority.service';
export * from './lib/grants/plugin-grant.service';
export * from './lib/lifecycle/plugin-lifecycle.listener';
export * from './lib/loader/entrypoint-resolver';
export * from './lib/loader/installed-plugin-directory';
export * from './lib/loader/loader.errors';
export * from './lib/loader/path-containment';
export * from './lib/loader/plugin-definition';
export * from './lib/loader/plugin-directory-resolver.service';
export * from './lib/loader/plugin-instance-registry';
export * from './lib/loader/plugin-loader.service';
export * from './lib/loader/plugin-module-importer';
export * from './lib/plugin-module.options';
export * from './lib/plugin.module';
export * from './lib/registry/base-plugin-registry';
export * from './lib/registry/plugin-category.map';
export * from './lib/registry/registry.errors';

// DELIBERATELY NOT EXPORTED: './lib/registry/base-plugin-registry.contract'.
// The contract suite imports `@jest/globals`, which throws when evaluated
// outside a Jest run, so re-exporting it here put that import in the runtime
// graph of every consumer of this barrel — including the api app, which
// imports PluginModule. Subclass specs import it by relative path. The
// storage and gateway contract suites live in dedicated
// `@boardgamesempire/*-contract-testing` libs for this reason; extracting
// this one the same way is a tracked follow-up.
