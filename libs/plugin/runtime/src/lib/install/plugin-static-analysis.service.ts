import type { StaticAnalysisOptions, StaticAnalysisReport } from '@boardgamesempire/plugin-analysis';
import { PluginStaticAnalyzer } from '@boardgamesempire/plugin-analysis';
import type { PluginArtifactDirectory } from '@boardgamesempire/plugin-contract';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Install-time static analysis (#59), as a Nest provider. The scan itself —
 * what gates, what only warns, what it can and cannot see — lives in
 * `PluginStaticAnalyzer` in `@boardgamesempire/plugin-analysis`, so a plugin
 * author's tools run the same code the server does (#1093). This wrapper
 * hands it the server's logger and keeps the signature the installer and
 * the update flow call.
 *
 * `PluginArtifactDirectory` satisfies the analyzer's `PluginCodeRoot`
 * structurally, so no mapping happens here.
 */
@Injectable()
export class PluginStaticAnalysisService {
  private readonly analyzer = new PluginStaticAnalyzer(new Logger(PluginStaticAnalysisService.name));

  analyze(directory: PluginArtifactDirectory, options: StaticAnalysisOptions): Promise<StaticAnalysisReport> {
    return this.analyzer.analyze(directory, options);
  }
}
