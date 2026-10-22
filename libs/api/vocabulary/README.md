# vocabulary

`@bge/vocabulary` matches what a DataGateway sends for a platform, category,
mechanic or family to a record, through that vocabulary's DataGateway link
(#718). Import and the list jobs share it, so both match an entry the same
way: by its link first, then by slug, then, for all but platforms, by a
similar name.

The platform, category and mechanic links carry a review status. While a
vocabulary's review setting is on, an entry that matches nothing waits as a
Pending link, and the review service backs the admin routes that link,
ignore or accept it (#715). Families have no review.

Each vocabulary keeps its own link table, with a foreign key to its record,
and one adapter here. A new vocabulary adds a table and an adapter.

## Running unit tests

Run `npm run nx test vocabulary` to execute the unit tests via [Jest](https://jestjs.io).
