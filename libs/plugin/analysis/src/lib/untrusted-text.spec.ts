import { quoteUntrustedText } from './untrusted-text.js';

describe('quoteUntrustedText (#1093)', () => {
  it('quotes the text (#1093)', () => {
    expect(quoteUntrustedText('package/a.js')).toBe('"package/a.js"');
  });

  it('escapes a newline so the text cannot forge a line in a message (#1093)', () => {
    const quoted = quoteUntrustedText('package/a\nforged line');

    expect(quoted).not.toContain('\n');
    expect(quoted).toBe('"package/a\\nforged line"');
  });

  it('cuts text whose quoted form is over 200 characters and marks the cut (#1093)', () => {
    const quoted = quoteUntrustedText('z'.repeat(400));

    expect(quoted).toBe(`"${'z'.repeat(199)}...`);
    expect(quoted).toHaveLength(203);
  });

  it('keeps text whose quoted form is exactly 200 characters (#1093)', () => {
    const quoted = quoteUntrustedText('z'.repeat(198));

    expect(quoted).toBe(`"${'z'.repeat(198)}"`);
    expect(quoted).toHaveLength(200);
  });
});
