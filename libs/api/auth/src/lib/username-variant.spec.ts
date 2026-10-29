import { createUsernameVariants, firstFreeUsername } from './username-variant';

describe('firstFreeUsername', () => {
  it('keeps a free username (#912)', () => {
    expect(firstFreeUsername('jason', new Set())).toBe('jason');
  });

  it('takes the first free variant, starting at 2 (#912)', () => {
    expect(firstFreeUsername('jason', new Set(['jason']))).toBe('jason-2');
    // jason-10 exists, but jason-3 is the least free number, not the one after the largest.
    expect(firstFreeUsername('jason', new Set(['jason', 'jason-2', 'jason-10']))).toBe('jason-3');
  });
});

describe('createUsernameVariants', () => {
  const PROVIDER_CONTEXT = { path: '/oauth2/callback/:providerId' };

  /**
   * `startsWith` as Postgres LIKE reads it: `_` matches any one character, `%`
   * any run, and a backslash makes the next character match only itself.
   */
  const likePrefix = (prefix: string): RegExp => {
    const literal = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let source = '^';

    for (let i = 0; i < prefix.length; i += 1) {
      const char = prefix[i];

      if (char === '\\') {
        i += 1;
        source += literal(prefix[i] ?? '');
      } else {
        source += char === '_' ? '.' : char === '%' ? '.*' : literal(char);
      }
    }

    return new RegExp(source);
  };

  const prismaWith = (...taken: string[]) => {
    const findUnique = jest.fn(({ where }: { where: { username: string } }) =>
      Promise.resolve(taken.includes(where.username) ? { id: `id-${where.username}` } : null),
    );
    const findMany = jest.fn(({ where }: { where: { username: { startsWith: string } } }) =>
      Promise.resolve(
        taken
          .filter((username) => likePrefix(where.username.startsWith).test(username))
          .map((username) => ({ username })),
      ),
    );

    return { prisma: { user: { findUnique, findMany } } as never, findUnique, findMany };
  };

  it('gives a provider sign-in whose username is taken the first free variant, and remembers the requested one (#912)', async () => {
    const { prisma } = prismaWith('jason', 'jason-2', 'jason-10');
    const variants = createUsernameVariants(prisma);

    await expect(variants.beforeUserCreate({ name: 'jason' }, PROVIDER_CONTEXT)).resolves.toEqual({
      data: { name: 'jason-3' },
    });
    expect(variants.requestedUsername(PROVIDER_CONTEXT)).toBe('jason');
  });

  // Not every username starting with the request: `j` would read every `j…`.
  it('reads only the hyphenated variants of a taken username (#912)', async () => {
    const { prisma, findMany } = prismaWith('jason');

    await createUsernameVariants(prisma).beforeUserCreate({ name: 'jason' }, PROVIDER_CONTEXT);

    expect(findMany).toHaveBeenCalledWith({
      where: { username: { startsWith: 'jason-' } },
      select: { username: true },
    });
  });

  // The variant lookup is a prefix LIKE the unique index can't serve, so a
  // free username, the usual case, never runs it.
  it('changes nothing, remembers nothing and reads no variants when the username is free (#912)', async () => {
    const { prisma, findMany } = prismaWith('someone-else');
    const variants = createUsernameVariants(prisma);

    await expect(variants.beforeUserCreate({ name: 'jason' }, PROVIDER_CONTEXT)).resolves.toBeUndefined();
    expect(variants.requestedUsername(PROVIDER_CONTEXT)).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('leaves an email sign-up alone even when its username is taken (#912)', async () => {
    const { prisma, findUnique } = prismaWith('jason');
    const variants = createUsernameVariants(prisma);
    const context = { path: '/sign-up/email' };

    await expect(variants.beforeUserCreate({ name: 'jason' }, context)).resolves.toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
    expect(variants.requestedUsername(context)).toBeNull();
  });

  it('leaves a user created outside an endpoint alone (#912)', async () => {
    const { prisma, findUnique } = prismaWith('jason');

    await expect(createUsernameVariants(prisma).beforeUserCreate({ name: 'jason' }, null)).resolves.toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 42])('leaves a name of %p alone (#912)', async (name) => {
    const { prisma, findUnique } = prismaWith('jason');

    await expect(createUsernameVariants(prisma).beforeUserCreate({ name }, PROVIDER_CONTEXT)).resolves.toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('escapes LIKE wildcards in the request, so they match only themselves (#912)', async () => {
    // Unescaped, the `_` would match the `x` in `axb-2`.
    const { prisma, findMany } = prismaWith('a_b', 'axb-2', 'a%c', 'a%c-2', 'abc-3');

    await expect(createUsernameVariants(prisma).beforeUserCreate({ name: 'a_b' }, PROVIDER_CONTEXT)).resolves.toEqual({
      data: { name: 'a_b-2' },
    });
    await expect(createUsernameVariants(prisma).beforeUserCreate({ name: 'a%c' }, PROVIDER_CONTEXT)).resolves.toEqual({
      data: { name: 'a%c-3' },
    });
    expect(findMany.mock.calls.map(([args]) => args.where.username.startsWith)).toEqual(['a\\_b-', 'a\\%c-']);
  });

  // Unescaped, `a\b-` reads as `ab-` and misses `a\b-2`, so every retry would
  // pick the same taken variant and fail on the unique index.
  it('finds the taken variants of a username containing a backslash (#912)', async () => {
    const { prisma } = prismaWith('a\\b', 'a\\b-2');

    await expect(createUsernameVariants(prisma).beforeUserCreate({ name: 'a\\b' }, PROVIDER_CONTEXT)).resolves.toEqual({
      data: { name: 'a\\b-3' },
    });
  });

  it('remembers nothing for a context it has not seen (#912)', () => {
    const variants = createUsernameVariants(prismaWith().prisma);

    expect(variants.requestedUsername({})).toBeNull();
    expect(variants.requestedUsername(null)).toBeNull();
  });
});
