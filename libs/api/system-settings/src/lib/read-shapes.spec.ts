import { Prisma } from '@bge/database';
import { SYSTEM_SETTINGS_SCALARS_OMITTED, SYSTEM_SETTINGS_SELECT } from './read-shapes';

/**
 * Both system-settings routes used to return the row as stored, so
 * `mediaSigningSecret` reached every staff reader, Moderator included (#572).
 *
 * The first spec reads the model's scalars out of the GENERATED client rather
 * than a hand-written list, as the household read shapes do (#297). A column
 * added to `prisma/models` fails it until someone classifies it as published or
 * withheld.
 */
describe('system settings read shape', () => {
  it('classifies every SystemSetting scalar as either selected or deliberately omitted', () => {
    const declared = Object.values(Prisma.SystemSettingScalarFieldEnum).sort();
    const classified = [...Object.keys(SYSTEM_SETTINGS_SELECT), ...Object.keys(SYSTEM_SETTINGS_SCALARS_OMITTED)].sort();

    // A new column lands here first. Publish it by adding it to
    // SYSTEM_SETTINGS_SELECT, or withhold it by adding it to
    // SYSTEM_SETTINGS_SCALARS_OMITTED with the reason.
    expect(classified).toEqual(declared);
  });

  it('withholds the signing secret and the row bookkeeping', () => {
    expect(Object.keys(SYSTEM_SETTINGS_SCALARS_OMITTED).sort()).toEqual(
      ['identifier', 'mediaSigningSecret', 'singleton'].sort(),
    );
  });

  it('publishes the row id and the ten settings', () => {
    expect(Object.keys(SYSTEM_SETTINGS_SELECT).sort()).toEqual(
      [
        'id',
        'name',
        'allowPasswordResets',
        'allowUserRegistration',
        'allowUsernameChange',
        'feedbackReportRetentionDays',
        'feedbackReportServerRedactionEnabled',
        'requireContributionApproval',
        'contributionReclaimDays',
        'auditLogRetentionDays',
        'reviewGatewayLanguages',
      ].sort(),
    );
  });
});
