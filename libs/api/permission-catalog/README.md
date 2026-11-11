# permission-catalog

The Owner's routes over the permission catalog (#772), under `/permission-catalog`:

- `GET /`: read every permission and role, with its grants and its drift from the permission catalog this version ships.
- `PATCH /permissions/:slug`: edit a permission's condition, reason or risk level, or retire or revive it.
- `PATCH /roles/:name`: edit a role's description.
- `PUT /roles/:name/grants/:slug`: give a role a permission, or give back a revoked grant.
- `DELETE /roles/:name/grants/:slug`: take a permission from a role.
- `POST /permissions/:slug/hand-back`, `POST /roles/:name/hand-back` and `POST /roles/:name/grants/:slug/hand-back`: hand an entry back to the server, so the next start brings it in line with the permission catalog this version ships.

## Running unit tests

Run `npm run nx -- test @board-games-empire/permission-catalog` to execute the unit tests via [Jest](https://jestjs.io).
