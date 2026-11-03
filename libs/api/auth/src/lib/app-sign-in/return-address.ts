/**
 * The longest return address an app may send, in characters once encoded
 * (#1019). The flow stores the encoded form, its `href`, and reads it back
 * through this check, so the limit applies to that form: a non-ASCII
 * character is up to twelve characters encoded, and an address measured as
 * sent could open a flow its callback then refuses.
 */
const RETURN_ADDRESS_MAX_LENGTH = 512;

/**
 * The official app's return address: `bge://oauth`, with any path and nothing
 * else. Matched on the string as sent, because URL parsing drops a `?`, `#`,
 * `@` or `:` with nothing after it, and escapes a space, so the parsed address
 * can't show them.
 */
const RETURN_ADDRESS_PATTERN = /^bge:\/\/oauth(?:\/[^?#\s]*)?$/i;

// eslint-disable-next-line no-control-regex -- the control characters are what it looks for
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The return address a native app asked for, parsed, when it is one this
 * server sends a sign-in to, or `null` (#1019).
 *
 * Only the official app's address, `bge://oauth`, is accepted. A sign-in code
 * sent anywhere else could reach someone other than the app that asked for it.
 * Third-party apps' addresses are #1048. The address is never one of
 * better-auth's trusted origins, so nothing else on the server accepts it.
 */
export function parseAppReturnAddress(value: string): URL | null {
  if (
    value.length > RETURN_ADDRESS_MAX_LENGTH ||
    CONTROL_CHARACTERS.test(value) ||
    !RETURN_ADDRESS_PATTERN.test(value)
  ) {
    return null;
  }

  let address: URL;
  try {
    address = new URL(value);
  } catch {
    return null;
  }

  // The same rule on the parsed address, as a second line behind the pattern.
  const exact =
    address.href.length <= RETURN_ADDRESS_MAX_LENGTH &&
    address.protocol === 'bge:' &&
    address.host.toLowerCase() === 'oauth' &&
    address.port === '' &&
    address.username === '' &&
    address.password === '' &&
    address.search === '' &&
    address.hash === '';

  return exact ? address : null;
}

/**
 * The address to send the app to: `address` with each parameter that has a
 * value set in its query, in the order given (#1019). Values are encoded, so
 * the app gets its own `state` back byte for byte.
 */
export function appReturnUrl(address: URL, params: Readonly<Record<string, string | undefined>>): string {
  const target = new URL(address.href);

  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      target.searchParams.set(name, value);
    }
  }

  return target.href;
}
