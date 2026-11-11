import { NotFoundException, type ArgumentMetadata } from '@nestjs/common';
import { CatalogEntryNamePipe } from './catalog-entry-name.pipe';

const param = (data: 'slug' | 'name'): ArgumentMetadata => ({ type: 'param', data, metatype: String });

describe('CatalogEntryNamePipe (#772)', () => {
  const pipe = new CatalogEntryNamePipe();

  it('passes a slug or a role name through as it is', () => {
    expect(pipe.transform('update:household_invite:revoke:as-admin', param('slug'))).toBe(
      'update:household_invite:revoke:as-admin',
    );
    expect(pipe.transform('HouseholdGuest', param('name'))).toBe('HouseholdGuest');
  });

  // Postgres stores no NUL in text and refuses a query that compares one, a
  // bare 500. No entry can be named so: it is answered as any unknown name is.
  it('answers a slug holding NUL with 404 CATALOG_ENTRY_NOT_FOUND, before any query', () => {
    const slug = 'read:game\u0000';

    expect(() => pipe.transform(slug, param('slug'))).toThrow(NotFoundException);
    expect(() => pipe.transform(slug, param('slug'))).toThrow(
      expect.objectContaining({
        response: {
          code: 'CATALOG_ENTRY_NOT_FOUND',
          message: expect.objectContaining({ key: 'errors.permission_catalog.entry_not_found', args: { slug } }),
        },
      }),
    );
  });

  it("answers a role name holding NUL with 404 CATALOG_ENTRY_NOT_FOUND and the role's message", () => {
    const name = '\u0000User';

    expect(() => pipe.transform(name, param('name'))).toThrow(
      expect.objectContaining({
        response: {
          code: 'CATALOG_ENTRY_NOT_FOUND',
          message: expect.objectContaining({ key: 'errors.permission_catalog.role_not_found', args: { name } }),
        },
      }),
    );
  });
});
