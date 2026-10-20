import { SystemRole, type DatabaseService } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { findServerAdminIds } from './server-admins';

describe('findServerAdminIds', () => {
  let db: MockDatabaseService;

  beforeEach(() => {
    db = createMockDatabaseService();
  });

  it('finds the users holding the Owner or Admin server role (#763)', async () => {
    db.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }] as never);

    await expect(findServerAdminIds(db as unknown as DatabaseService)).resolves.toEqual(['admin-1', 'admin-2']);

    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { roles: { some: { role: { name: { in: [SystemRole.Owner, SystemRole.Admin] } } } } },
      select: { id: true },
    });
  });
});
