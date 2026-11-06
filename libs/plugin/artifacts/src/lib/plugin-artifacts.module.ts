import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { PluginArtifactInstaller } from './install/plugin-artifact.installer';
import { PluginArtifactReceiver } from './receive/plugin-artifact.receiver';
import { PluginArtifactStore } from './store/plugin-artifact.store';

/**
 * The server side of the install ingress (#1094): receiving a plugin artifact
 * by link or upload, reading it back, and installing it by its checksum.
 *
 * Its other collaborators come from global modules the host configures once.
 * The plugin runtime, `PluginModule.forRootAsync`, exports the installer, the
 * directory resolver, the authority check and its module options, which name
 * the plugins root. Importing `PluginModule` here would build a second runtime
 * with no options. `SecureHttpModule` provides the download. The database
 * module is not global, so it is imported.
 */
@Module({
  imports: [DatabaseModule],
  providers: [PluginArtifactReceiver, PluginArtifactInstaller, PluginArtifactStore],
  exports: [PluginArtifactReceiver, PluginArtifactInstaller, PluginArtifactStore],
})
export class PluginArtifactsModule {}
