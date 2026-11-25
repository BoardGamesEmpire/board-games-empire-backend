import type { ValidationReport } from './report.js';
import { renderJson, renderText } from './report.js';

const report: ValidationReport = {
  errors: [
    { at: 'dist/index.js', code: 'esm-import', message: 'The code imports "axios", a forbidden import.' },
    { code: 'MANIFEST_UNREADABLE', message: 'The manifest could not be read.' },
  ],
  notes: [{ code: 'NOT_CHECKED_BEYOND_SCAN', message: 'The scan does not run the code.' }],
  warnings: [{ at: 'dist/x.js', code: 'non-literal-require', message: 'The scan cannot tell what is loaded.' }],
};

const empty: ValidationReport = { errors: [], notes: [], warnings: [] };

describe('renderText (#1093)', () => {
  it('prints one line per item as "<severity> <code> <at>: <message>", errors first, then a summary', () => {
    expect(renderText(report).split('\n')).toEqual([
      'error esm-import dist/index.js: The code imports "axios", a forbidden import.',
      'error MANIFEST_UNREADABLE: The manifest could not be read.',
      'warning non-literal-require dist/x.js: The scan cannot tell what is loaded.',
      'note NOT_CHECKED_BEYOND_SCAN: The scan does not run the code.',
      '2 errors, 1 warning',
      '',
    ]);
  });

  it('counts in the singular and plural and leaves notes out of the summary', () => {
    expect(renderText({ ...empty, errors: [report.errors[1]] })).toBe(
      'error MANIFEST_UNREADABLE: The manifest could not be read.\n1 error, 0 warnings\n',
    );
    expect(renderText({ ...empty, notes: report.notes })).toMatch(/\n0 errors, 0 warnings\n$/);
  });

  it('indents the continuation lines of a message, so each report line still starts with a severity', () => {
    const text = renderText({
      ...empty,
      errors: [{ code: 'PLUGIN_BUILD_FAILED', message: 'The build failed.\nnpm ERR! one\nnpm ERR! two' }],
    });

    expect(text.split('\n')).toEqual([
      'error PLUGIN_BUILD_FAILED: The build failed.',
      '  npm ERR! one',
      '  npm ERR! two',
      '1 error, 0 warnings',
      '',
    ]);
  });

  it('quotes a location that could break the line form, such as an entry name from a hostile plugin artifact', () => {
    const text = renderText({
      ...empty,
      errors: [{ at: 'package/x\nerror forged', code: 'unsafe-path', message: 'Refused.' }],
    });

    expect(text.split('\n')[0]).toBe('error unsafe-path "package/x\\nerror forged": Refused.');
    expect(renderText({ ...empty, errors: [{ at: 'a b.js', code: 'read-failure', message: 'x.' }] })).toContain(
      'error read-failure "a b.js": x.',
    );
  });
});

describe('renderJson (#1093)', () => {
  it('writes one JSON document with ok, errors, warnings and notes', () => {
    const text = renderJson({ report });
    const parsed: unknown = JSON.parse(text);

    expect(text.endsWith('\n')).toBe(true);
    expect(parsed).toEqual({ errors: report.errors, notes: report.notes, ok: false, warnings: report.warnings });
  });

  it('is ok with warnings and notes but no errors, and carries the artifact when one was written', () => {
    const artifact = { path: '/p/x-1.0.0.tgz', sha256: 'ab'.repeat(32), sidecarPath: '/p/x-1.0.0.tgz.sha256' };
    const parsed: unknown = JSON.parse(renderJson({ artifact, report: { ...report, errors: [] } }));

    expect(parsed).toEqual({ artifact, errors: [], notes: report.notes, ok: true, warnings: report.warnings });
  });
});
