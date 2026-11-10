-- #772: the permission catalog's own tables become resource types, so the
-- routes that edit them can name their subject. No role is given a slug on
-- them; staff read them through their read on `all`, and only the Owner's
-- manage:all writes them.

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'Permission';
ALTER TYPE "resource_types" ADD VALUE 'Role';
ALTER TYPE "resource_types" ADD VALUE 'RolePermission';
