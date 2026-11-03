import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ADMIN_HOUSEHOLD_SEARCH_MAX_LENGTH,
  ADMIN_HOUSEHOLD_SORTS,
  ADMIN_HOUSEHOLD_STATUSES,
  AdminHouseholdListQueryDto,
} from './admin-household-list.query.dto';

/**
 * The query of the staff households list (#419). Each failure names a
 * validation catalog key, so the edge renders it in the request locale.
 */
describe('AdminHouseholdListQueryDto', () => {
  const keysFor = async (plain: Record<string, unknown>) =>
    validationCatalogKeys(await validate(plainToInstance(AdminHouseholdListQueryDto, plain)));

  it('defaults to live households in name order', () => {
    const query = plainToInstance(AdminHouseholdListQueryDto, {});

    expect(query.status).toBe('live');
    expect(query.sort).toBe('name');
  });

  it('accepts every status with every sort the list offers, but deleted with live', async () => {
    for (const status of ADMIN_HOUSEHOLD_STATUSES) {
      for (const sort of ADMIN_HOUSEHOLD_SORTS) {
        if (sort === 'deleted' && status === 'live') {
          continue;
        }

        expect(await keysFor({ status, sort })).toEqual({});
      }
    }
  });

  it('refuses an unknown status or sort with the isIn key', async () => {
    expect(await keysFor({ status: 'archived' })).toEqual({ 'status.isIn': 'validation.isIn' });
    expect(await keysFor({ sort: 'oldest' })).toEqual({ 'sort.isIn': 'validation.isIn' });
  });

  it('refuses a search term shorter than 2 characters', async () => {
    expect(await keysFor({ q: 'a' })).toEqual({ 'q.minLength': 'validation.minLength' });
  });

  it('accepts a search term of 2 characters', async () => {
    expect(await keysFor({ q: 'ab' })).toEqual({});
  });

  // The term is matched against three columns in both the page read and the
  // count, so its length is capped as the page size is (#11, #419).
  it('accepts a search term of the maximum length and refuses a longer one', async () => {
    expect(await keysFor({ q: 'a'.repeat(ADMIN_HOUSEHOLD_SEARCH_MAX_LENGTH) })).toEqual({});
    expect(await keysFor({ q: 'a'.repeat(ADMIN_HOUSEHOLD_SEARCH_MAX_LENGTH + 1) })).toEqual({
      'q.maxLength': 'validation.maxLength',
    });
  });

  // Postgres refuses a null character in text, so without this check the
  // term would fail in the database as a 500 rather than here as a 400 (#419).
  it('refuses a search term with a null character in it', async () => {
    expect(await keysFor({ q: 'ab\u0000cd' })).toEqual({ 'q.notContains': 'validation.noNullCharacter' });
  });

  // A term of spaces would otherwise pass the length check and match every
  // name with two spaces in a row, which is no search anyone meant (#419).
  it('trims the search term before checking it, so a term of spaces is refused', async () => {
    expect(await keysFor({ q: '   ' })).toEqual({ 'q.minLength': 'validation.minLength' });
    expect(await keysFor({ q: ' a ' })).toEqual({ 'q.minLength': 'validation.minLength' });
    expect(plainToInstance(AdminHouseholdListQueryDto, { q: '  Catan  ' }).q).toBe('Catan');
  });

  it('refuses sort=deleted with status=live', async () => {
    expect(await keysFor({ sort: 'deleted', status: 'live' })).toEqual({
      'sort.deletedSortNeedsDeletedRows': 'validation.deletedSortNeedsDeletedRows',
    });
  });

  // The default status is live, so leaving it out is asking for live rows.
  // Refusing it tells a client that forgot `status` at once, rather than
  // answering a "most recently deleted" order over rows none of which are.
  it('refuses sort=deleted with status left out, since the default is live (#419)', async () => {
    expect(await keysFor({ sort: 'deleted' })).toEqual({
      'sort.deletedSortNeedsDeletedRows': 'validation.deletedSortNeedsDeletedRows',
    });
  });

  it('accepts sort=deleted with status=deleted or status=all', async () => {
    expect(await keysFor({ sort: 'deleted', status: 'deleted' })).toEqual({});
    expect(await keysFor({ sort: 'deleted', status: 'all' })).toEqual({});
  });
});
