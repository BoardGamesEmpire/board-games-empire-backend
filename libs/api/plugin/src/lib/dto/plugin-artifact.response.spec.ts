import { PLUGIN_UPDATE_STAGING_REFUSALS } from '@bge/plugin';
import { DECORATORS } from '@nestjs/swagger';
import 'reflect-metadata';
import { PluginArtifactResponseDto } from './plugin-artifact.response';

describe('PluginArtifactResponseDto', () => {
  const property = (target: object, key: string): Record<string, unknown> =>
    Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, target, key) as Record<string, unknown>;

  it("documents the update block's refusal as every staging refusal the runtime names (#1096)", () => {
    const update = property(PluginArtifactResponseDto.prototype, 'update');
    const refusal = property((update['type'] as { prototype: object }).prototype, 'refusal');

    expect(update['nullable']).toBe(true);
    expect(refusal['enum']).toEqual([...PLUGIN_UPDATE_STAGING_REFUSALS]);
    expect(refusal['nullable']).toBe(true);
  });
});
