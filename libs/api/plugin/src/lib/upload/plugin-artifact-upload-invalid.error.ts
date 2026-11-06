/**
 * A multipart request the plugin artifact upload cannot take (#1094): a
 * second file, a file in a field other than `file`, too many fields, or a
 * field name or value past multer's limits. `name` is the stable code a
 * client can match on, and `PluginExceptionFilter` renders localized copy.
 * Multer's own error, whose English message names the field, is kept as the
 * cause, for the log.
 */
export class PluginArtifactUploadInvalidError extends Error {
  override readonly name = 'PluginArtifactUploadInvalidError';

  constructor(options?: ErrorOptions) {
    super('The upload is not a multipart form this route takes', options);
  }
}
