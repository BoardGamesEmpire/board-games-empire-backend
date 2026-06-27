import { formatContentDisposition } from './content-disposition.util';

describe('formatContentDisposition', () => {
  it('emits an ascii fallback plus an RFC 5987 filename* for non-ascii names', () => {
    const header = formatContentDisposition('attachment', 'résumé.pdf');
    expect(header.startsWith('attachment;')).toBe(true);
    expect(header).toContain('filename="r_sum_.pdf"');
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  it('strips quotes and backslashes from the ascii fallback', () => {
    const header = formatContentDisposition('inline', 'a"b\\c.png');
    expect(header).toContain('filename="a_b_c.png"');
  });
});
