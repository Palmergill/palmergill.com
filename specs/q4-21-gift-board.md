# Spec 21 — Gift Board

- **Quarter:** Q4 2026 (Oct–Dec)
- **Status:** implemented — P1–P4 built (Oct 2026); P5 (claiming) is an open question
- **Depends on:** site member accounts (`backend/app/accounts.py`, `app_users`)
- **Areas:** `gifts/` (new), `backend/app/routers/gifts.py` (new),
  `backend/app/services/gift_board.py` (new), `backend/app/database.py`,
  `backend/app/main.py`, `index.html`, `shared/site-nav.js`, `e2e/gifts.spec.js` (new)

## Summary

A page at `/gifts/` where a signed-in member keeps two kinds of list in one
place:

1. **Ideas for other people.** When you think of a gift for someone, you add it
   under that person. These are private to you, always.
2. **Your own wishlist.** When you find something you like, you add it to
   yourself. Your wishlist is visible to every signed-in member, so friends and
   family can see what you want.

You work in a **board** (one column per person, you first) and can switch to a
**graph** of the same data (you in the centre, people around you, gifts
hanging off each person).

## Background

Gift ideas tend to come up at random times, months before a birthday, and
then get lost in notes apps and text threads. The other half of the same
problem is the person on the receiving end: "what do you want?" usually gets a
shrug. A small tool that captures both sides fits the site's personal
playground purpose, and the plumbing it needs is already here: member
accounts, signed sessions, the JSON-403 pattern from personal rankings, and
the warm site theme.

## Goals

1. Capturing an idea takes seconds: a name and optionally a link, price and note.
2. Ideas for someone else can never be seen by anyone except their author.
3. A member's own wishlist is easy for other members to browse.
4. The board and graph show the same data, and switching between them is just a
   view toggle.
5. Track an idea through `idea → bought → given` so you don't buy something twice
   and can see what you gave last year.

## Non-goals

- **No link scraping.** The server never fetches a pasted URL to pull a title or
  image. Fetching user-supplied URLs server-side is an SSRF surface, and typing a
  title is fine. (Could be revisited client-side or with an allowlist later.)
- **No purchasing, price tracking or affiliate links.**
- **No admin access to private ideas.** Same rule as personal rankings: these are
  personal notes, not moderated content.
- **No new framework, build step or graph library.** Plain JS and inline SVG,
  like the rest of the site.
- **No public (signed-out) wishlists in v1.** Visibility is "any signed-in member"
  by decision. A share-by-link mode is an open question below.

## Requirements

- **R1. One item table, one privacy rule.** Every gift is a row in `gift_items`.
  `person_id IS NULL` means "on the owner's own wishlist"; `person_id` set means
  "an idea for one of the owner's people". The visibility rule follows from that
  one column:
  - own wishlist rows → readable by any signed-in member;
  - idea rows → readable only by `owner_username`, by every route, always.
  There is no per-item visibility flag. A flag would be one more thing that
  could be wrong.
- **R2. People are private contacts.** A person is a name (plus optional notes
  and dates) that belongs to one account. Your people never need a site account,
  and nobody can see who is on your list.
- **R3. Board view.** One column per person, "Me" pinned first. Each column holds
  its items as cards with title, price, link and status. Add an item inline at the
  bottom of a column. Columns can be reordered; items within a column can be
  reordered (sparse float `sort_key`, as in spec 18 R2).
- **R4. Graph view.** Same data, drawn as inline SVG with a deterministic radial
  layout: Me at the centre, people evenly spaced on a ring, each person's items
  fanned out on a short arc beyond them. Deterministic, not force-directed, so the
  picture doesn't move between visits and needs no physics code. Clicking a node
  opens the same item editor as the board. Given items are dimmed. The graph is a
  view; it has no endpoints of its own.
- **R5. Status.** Ideas move `idea → bought → given`, with an optional
  `given_on` date and occasion label. Own wishlist items are `wanted` or
  `received`. A `received` item drops off what other members see but stays in
  your own history.
- **R6. Browsing wishlists.** `/gifts/` has a "Wishlists" panel listing members
  who have at least one `wanted` item. Opening one shows that member's wishlist
  read-only. Members with an empty wishlist are left out of the list.
- **R7. Member boundary.** Every `/api/gifts/*` route returns JSON 403 to
  anonymous callers (never a `WWW-Authenticate` 401). Someone else's person or
  idea returns 404, not 403, so ids can't be enumerated. The admin is treated as
  a member: they get their own board and can browse wishlists, but they have no
  route to anyone else's ideas.
- **R8. Input limits.** Title ≤ 200 chars, note ≤ 2,000, at most 100 people and
  1,000 items per account. URLs must be `http(s)` and are rendered with
  `rel="noopener noreferrer nofollow"` and never fetched. Price is stored as
  integer cents.
- **R9. Page access.** `/gifts/` is deliberately **not** a member path, for the
  same reason as `/fantasy/`: anonymous visitors get a short teaser and a sign-in
  prompt instead of a bounce to `/login/`. The page is an empty shell, and the
  API is the boundary.

## Design decisions

**Null `person_id` means "me".** The alternative, a "self" row in `gift_people`,
puts the most important privacy decision behind a join and a boolean. With the
null convention, the only query that ever crosses accounts is
`WHERE owner_username = :u AND person_id IS NULL AND status = 'wanted'`, and
everything else is filtered on `owner_username = :me`. That makes the privacy
boundary easy to review and easy to test.

**Private contacts, not links between accounts (for now).** Making people real
site accounts would let you see a friend's wishlist inside their column, but it
also brings in friend requests and a second path where data crosses accounts.
v1 keeps people as plain names. P4 adds an optional link from a contact to a
member, which is read-only and one-way: it shows their public wishlist next to
your private ideas and never the reverse.

**`username` strings, not foreign keys to `app_users`.** Same as
`ff_rank_boards` and `ff_draft_players`: the admin authenticates from env vars
and has no row there.

**One shared `require_member`.** `routers/fantasy_rankings.py` and
`routers/fantasy_league.py` each define their own. The gifts router should not
add a third copy; P1 moves the helper to a shared module (e.g.
`backend/app/accounts.py`) and points all three routers at it.

**Graph layout is radial, not force-directed.** At this scale (tens of people,
hundreds of items) a radial layout reads well and stays stable, and it's about
40 lines of trigonometry. A force simulation would mean a library or a
hand-written physics loop, plus a picture that changes every time.

## Data model

Prefixed `gift_`:

- `gift_people` — `id`, `owner_username`, `name`, `note`, `birthday` (nullable
  date), `sort_key` (float), `linked_username` (nullable, P4), `created_at`,
  `updated_at`. Unique on `(owner_username, name)`.
- `gift_items` — `id`, `owner_username`, `person_id` (nullable FK →
  `gift_people.id`, cascade delete), `title`, `url`, `price_cents`, `note`,
  `status` (`idea|bought|given|wanted|received`), `occasion`, `given_on`,
  `sort_key`, `created_at`, `updated_at`. Index on
  `(owner_username, person_id, status)`.

Both are new tables, so `Base.metadata.create_all` covers them and no
`database_migration.py` change is needed. A check (in the service layer, plus a
DB constraint where both SQLite and Postgres support it) keeps
`wanted|received` on own-wishlist rows and `idea|bought|given` on idea rows.

## API

All under `/api/gifts`, all member-only:

| Method | Path | Purpose |
|---|---|---|
| GET | `/board` | Caller's people and all of their items (ideas and wishlist) |
| POST / PATCH / DELETE | `/people[/{id}]` | Manage your people |
| POST / PATCH / DELETE | `/items[/{id}]` | Manage your items (`person_id` null = your wishlist) |
| POST | `/items/{id}/move` | Reorder or move an item to another column |
| GET | `/wishlists` | Members with ≥1 `wanted` item, with counts |
| GET | `/wishlists/{username}` | That member's `wanted` items: title, url, price, note |

Moving an item between "Me" and a person changes which side of the privacy
line it's on. The server enforces the matching status remap
(`wanted ↔ idea`). The UI confirms before moving an idea onto your public
wishlist.

## Phases

- **P1 (done).** Tables, service and router with the auth boundary. Shared
  `require_member` (now `accounts.require_member_identity`, used by the
  rankings and league routers too). `/gifts/` board: people columns, Me
  column, inline add/edit, status, reorder, "Hide given", birthday countdown.
  Teaser for anonymous visitors. ARCHITECTURE.md updated, since P1 deploys.
  As built:
  - Reordering and cross-column moves send a destination `index` rather than
    neighbour ids; the server works out the neighbours from the current order.
    Move routes return the whole board, because an exhausted key gap respreads
    the destination column.
  - No revision token, unlike spec 18. A board has one editor, and a
    last-write-wins race between two of your own tabs costs little.
  - Pointer users drag cards (HTML5 drag and drop). Touch and keyboard users
    move gifts from the editor (List, Move up, Move down), which works on every
    device, instead of a pointer-events drag implementation.
- **P2 (done).** A "Wishlists" tab next to "My board", routed in the hash
  (`#wishlists`, `#wishlist/<username>`) so members can share a link to a
  wishlist; the hash survives the sign-in redirect. The member list leaves out
  the caller, members with nothing wanted, and deactivated accounts. A member
  wishlist page offers "Add <name> to my board", which creates a person
  already linked to them (P4). Homepage card (05) and a "Gifts" nav entry.
  As built:
  - Wishlist responses carry only `id`, `title`, `url`, `priceCents` and
    `note`; no timestamps or status.
  - `GET /board` now also returns the caller's `username`, so the wishlist
    page can recognise "this is you" and show the member's-eye view.
- **P3 (done).** Graph view in `gifts/graph.js`, toggled Board / Graph next to
  the tabs and remembered in `localStorage`. Your wishlist sits on an inner
  ring in the gaps between the spokes to your people, so no gift node lands
  on a line; a person's gifts fan out on an arc beyond them, staggered onto
  two radii when there are more than five. Nodes are focusable buttons
  (Enter or Space opens the editor) and focus returns to the node after a
  save. "Hide given" applies. On a narrow screen the graph keeps a readable
  size and scrolls sideways inside its frame, centred on "Me" when it first
  appears.
- **P4 (done).** `gift_people.linked_username` (added by
  `database_migration.py` on existing deployments), set from the person
  editor's "Site account" field. A linked person's column shows "From
  <name>'s wishlist" under your ideas, collapsible, with "Save as idea" on
  each item, which turns into "Saved" once an idea with the same link or
  title exists. You can't link to yourself or to an unknown account; a link
  to an account that is later deactivated quietly stops resolving.
- **P5 (open).** Claiming. See open questions.

## Testing

- `backend/tests/test_gifts_api.py` (P1, built) — the auth boundary
  parametrized over every route (anonymous → 403 with no `WWW-Authenticate`;
  another member's person or idea → 404, including for the admin), and the
  privacy invariant: seed three accounts with uniquely named ideas, call every
  parameterless GET route under `/api/gifts` as each one, and assert that no
  response contains another account's idea or person. The test enumerates the
  routes from the app, so a new GET route is covered automatically, and a new
  route with a path parameter fails the test until it gets its own case. Also
  the status remap on move, reordering, key-gap respread, cascade on person
  delete, the DB check constraint, input limits, and URL scheme validation.
- `e2e/gifts.spec.js` (P1, built) — anonymous visitors see the teaser; a member
  adds a person, ideas and a wishlist item, edits price, link and status, moves
  an idea onto the wishlist through the confirm, reloads, and a second member
  sees an empty board; member B finds A in Wishlists and sees the wishlist
  item but not the idea, adds A to their board from there, saves one of A's
  items as an idea, and sees "Saved" in A's column; the board ↔ graph toggle
  keeps the same item count and survives a reload.

## Open questions

1. **Claiming ("I'm getting this").** Should another member be able to mark
   something on your wishlist as claimed, so two people don't buy the same
   thing? The usual approach: claims are visible to everyone *except* the
   wishlist owner. It's useful, but it's a third kind of visibility and the
   easiest place for a surprise to leak, so it's held back until P1–P4 are in
   use.
2. **Share links for non-members.** The 5-per-day signup cap is fine for
   family, but a grandparent may not want an account. An opt-in read-only share
   slug per wishlist (the spec 18 P3 pattern) would cover that.
3. **Occasion reminders.** People already carry a birthday. A "coming up in the
   next 30 days" strip at the top of the board is cheap; email reminders are not
   (the site sends no email today).
