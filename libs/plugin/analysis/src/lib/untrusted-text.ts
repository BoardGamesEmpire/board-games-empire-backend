/**
 * Untrusted text (an archive's entry name, a checksum a client sent): quote it
 * and cut it so it cannot forge lines in a message (#1093).
 */
export const quoteUntrustedText = (text: string): string => {
  const quoted = JSON.stringify(text);
  return quoted.length > 200 ? `${quoted.slice(0, 200)}...` : quoted;
};
