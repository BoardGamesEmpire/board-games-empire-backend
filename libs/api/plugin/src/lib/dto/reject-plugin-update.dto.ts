import { StagedUpdateAnswerDto } from './staged-update-answer.dto';

/** Rejecting a staged update carries only the staging it answers (#357, #1118). */
export class RejectPluginUpdateDto extends StagedUpdateAnswerDto {}
