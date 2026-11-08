import { RejectPluginUpdateDto } from './reject-plugin-update.dto';
import { StagedUpdateAnswerDto } from './staged-update-answer.dto';

// The `stagingId` rules are specified once in staged-update-answer.dto.spec.ts (#1118).
describe('RejectPluginUpdateDto', () => {
  it('adds nothing to the staged-update answer (#1118)', () => {
    expect(Object.getOwnPropertyNames(new RejectPluginUpdateDto())).toEqual([]);
    expect(new RejectPluginUpdateDto()).toBeInstanceOf(StagedUpdateAnswerDto);
  });
});
