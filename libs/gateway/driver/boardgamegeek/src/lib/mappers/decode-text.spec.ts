import { decodeDescription, decodeText } from './decode-text';

describe('decodeText (#716)', () => {
  it('decodes XML’s entities and numeric references once', () => {
    expect(decodeText('Tzolk&#039;in &amp; &quot;x&quot;')).toBe(`Tzolk'in & "x"`);
    expect(decodeText('a &amp;mdash; b')).toBe('a &mdash; b');
  });

  it('keeps text that looks like a number as BGG sent it (#863)', () => {
    expect(decodeText('007')).toBe('007');
    expect(decodeText('1e3')).toBe('1e3');
  });

  it('gives an absent value as empty text, never "undefined"', () => {
    expect(decodeText(undefined)).toBe('');
  });
});

describe('decodeDescription (#716)', () => {
  it('decodes a description twice, since BGG encodes its HTML entities again', () => {
    expect(decodeDescription('cities&amp;mdash;think, player&amp;rsquo;s')).toBe('cities—think, player’s');
  });

  it('leaves a run that only looks like an entity as it is', () => {
    expect(decodeDescription('R&amp;D &amp;notit')).toBe('R&D &notit');
  });

  it('passes an absent description through', () => {
    expect(decodeDescription(undefined)).toBeUndefined();
  });
});
