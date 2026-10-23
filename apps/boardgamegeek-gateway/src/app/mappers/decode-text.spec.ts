import { decodeDescription, decodeText } from './decode-text';

describe('decodeText (#716)', () => {
  it('decodes XML’s entities and numeric references once', () => {
    expect(decodeText('Tzolk&#039;in &amp; &quot;x&quot;')).toBe(`Tzolk'in & "x"`);
    expect(decodeText('a &amp;mdash; b')).toBe('a &mdash; b');
  });

  it('sends a value that arrived as a number or a boolean as text', () => {
    expect(decodeText(2048)).toBe('2048');
    expect(decodeText(true)).toBe('true');
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
