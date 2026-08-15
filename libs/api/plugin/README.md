# @bge/plugins

HTTP surface for the plugin system (#59 Phase C4): consent-collection
endpoints, the plugin domain-error → HTTP status mapping, and the admin
permission guard vocabulary.

The plural import alias is deliberate — `@bge/plugin` is the runtime lib
(loader, installer, grants, update seam); this lib renders that runtime's
surfaces over HTTP and owns nothing the runtime enforces: consent-gate
enforcement stays in services, and controllers pass confirmation fields
through (see the decision record on #59).

Slices land in order: #319 (this scaffold: filter + seeds + i18n), #320
(server lifecycle + uninstall), #321 (update approve/reject), #322 (grant
decide), #323 (unit enablement + feature state).
