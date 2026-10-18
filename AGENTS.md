# Project context

Board Games Empire is a pre-alpha, open source, self-hostable server for
managing board game and video game collections. This repo is the backend; the
web client lives in `BoardGamesEmpire/board-games-empire-client`.

Self-hosting is the primary goal. A hosted version may be offered eventually,
but it is secondary to the self-hosted server. Privacy and user control of
their data are core priorities and should guide product and technical decisions:

- Data stays in a database the operator controls. Outbound requests reach only
  the addresses the outbound HTTP policy allows.
- Plugins act only with the authority consented to them, never by borrowing the
  authority of whoever triggered them.
- Prefer behavior the server's own state decides over settings an operator has
  to remember to flip.

Accessibility is an equally high priority. The client renders the interface,
but the backend decides whether an accessible interface is possible:

- Media carries a text description (alt text) that the API stores and returns.
- Every user-facing string, including error messages and notifications, is
  plain language and localizable. Errors carry a stable code alongside the
  message, so a client can announce or rephrase them.
- Nothing depends on a single sense or on speed: no visual-only challenges, and
  time limits (sessions, invites, polls) are generous and extendable.
- Text the client displays (Markdown descriptions, for example) keeps its
  structure, so headings and lists survive for screen readers.

The intended scope includes allowing users to:

- Manage their board game and video game collections: ratings, favorites,
  lists, game locations and loans.
- Search DataGateways (BoardGameGeek, IGDB) and import games into the game
  catalog.
- Join households: trust groups of any size whose members share their games
  and plan play together. Living together is not required.
- Add friends and share with them.
- Plan events such as game nights, with RSVPs, availability polls and
  nominations and votes on which games to play.
- Record plays.
- Upload media, such as cover images and attachments.
- Receive notifications, and connect other tools through webhooks and plugins.

Operators get roles and permissions, quotas, an audit log and multilingual
game data.

These describe the project's direction, not a claim that all features already
exist. Many features are not yet implemented at this pre-alpha stage. Verify
the current implementation before describing a capability as available, and
treat a planned but unwired feature as intended, not unwanted.

Nothing is deployed yet, so breaking changes to the API, schema or migrations
need no backward-compatibility path.

For the phased plan, see `docs/ROADMAP.md` and `docs/PLUGIN_ROADMAP.md`. The
GitHub epics carry the current state.

## Working in this repo

- **Vocabulary**: name domain concepts with the terms in `GLOSSARY.md`, in
  code, tests, issues, docs and commit messages. Grep it for the noun you need;
  each entry's `_Avoid_:` line lists the synonyms to leave out.
- **Commands**: run Nx as `npm run nx <command>`, or a `package.json` script
  (`npm run typecheck`, `npm test`). The repo pins an Nx major that `npx nx` can
  bypass.
- **Lint** through the project's Nx target (`npm run nx run <project>:lint`).
  Libs carry their own ESLint config, which a bare `eslint <path>` from the root
  skips.
- **Format**: run `npm run nx -- format:check --all` before pushing; CI checks
  the whole tree. Prettier here removes unused imports, so read the diff after
  `prettier --write`.
- **Comments and test names** carry the reasoning and an issue reference
  (`#123`). Decision codes such as `D-123-4` belong in issues and commit
  messages only.
- **Feature-lib imports**: a new import from one `libs/api/*` feature lib into
  another is a structural choice. Ask first, and check it creates no cycle.
- **Gotchas**: before touching WebSocket gateways, `/api/auth` routes, Prisma
  bulk updates or permission conditions, config defaults, or a build, lint or
  test run you're about to trust, read `docs/agents/gotchas.md`.

## Agent skills

### Issue tracker

GitHub issues on `BoardGamesEmpire/board-games-empire-backend`, via the `gh` CLI; work closes through PRs. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels, each named for its role (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md`, ADRs in `docs/adr/`. See `docs/agents/domain.md`.
