import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { PluginArtifactInstaller } from './install/plugin-artifact.installer';
import { PluginArtifactReceiver } from './receive/plugin-artifact.receiver';
import { PluginArtifactStore } from './store/plugin-artifact.store';
import { PluginArtifactSweepService } from './sweep/plugin-artifact-sweep.service';

/**
 * The server side of the install ingress (#1094): receiving a plugin artifact
 * by link or upload, reading it back, installing it by its checksum, and the
 * sweep that removes what nothing needs from the plugins root.
 *
 * Its other collaborators come from global modules the host configures once.
 * The plugin runtime, `PluginModule.forRootAsync`, exports the installer, the
 * directory resolver, the authority check and its module options, which name
 * the plugins root. Importing `PluginModule` here would build a second runtime
 * with no options. `SecureHttpModule` provides the download. The database
 * module is not global, so it is imported, and so is `AuditContextModule`,
 * which provides the sweep's system actor scope over the host's global
 * `ClsModule`.
 *
 * The sweep runs at boot and hourly wherever this module is imported: in the
 * api, through `PluginsApiModule`, where `ScheduleModule.forRoot()` drives
 * the hourly run.
 */
@Module({
  imports: [AuditContextModule, DatabaseModule],
  providers: [PluginArtifactReceiver, PluginArtifactInstaller, PluginArtifactStore, PluginArtifactSweepService],
  exports: [PluginArtifactReceiver, PluginArtifactInstaller, PluginArtifactStore],
})
export class PluginArtifactsModule {}
