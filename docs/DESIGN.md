# Mystery Menu — design spec

Mobile-first party game for a table of friends. Two chefs each receive five
ingredients for a dish; nobody sees them until the referee reveals them. They bid
against each other for each ingredient out of a fixed coin budget. The table then
votes on which dish they would rather eat.

The format is lifted from the **GameTime Bros** "draft" videos (nine of them were
transcribed and frame-read while writing this spec). The rules below are the
observed rules, not an impression.

## Locked decisions

| # | Decision | Value |
|---|----------|-------|
| 1 | Agent loop brain | Venice models, dispatched through the Codex CLI pointed at Venice's Responses API |
| 2 | Name / repo | Mystery Menu — `vivmuk/mystery-menu` |
| 3 | Join | Barcode (QR) only. No accounts, no passwords, no email, ever |
| 4 | Host avatar | 3D Three.js character with real lip sync driven by its own TTS audio |
| 5 | Voting | One mode only: anonymous vote for the best dish — the one people would actually eat |
| 6 | Dietary | A vegetarian-only option that filters the whole ingredient pool |
| 7 | Ingredient art | Hybrid: a pre-generated canonical library plus live generation for the twist ingredient |
| 8 | Hosting | Railway, one service, Venice key as an environment variable |
| 9 | Numbers | 10 items per match, 5 per chef, 10 coins each, 10-second bid clock |
| 10 | Modes | Auction is the core; Worst Dish is an unlockable; Snake Draft is quick play |
| 11 | Referee role | The avatar runs the draft: announces, taunts, calls the concede, rules on gifts |
| 12 | The twist | Exactly one cross-cuisine ingredient per chef: plausible, from a cuisine that does not belong in this dish, never novelty candy |
| 13 | Bid input | Live ascending bids with a shot clock; a sealed-bid toggle for remote play |

Decisions 9–13 were taken as defaults from the source format; 9, 10 and 13 are the
cheapest to change and the least load-bearing.

## Rules of play

**Setup.** The host opens a room on one phone. A QR code and a 4-letter code
appear. Everyone else scans and types a name. Two of them become chefs; the rest
are the table.

**The deck.** A theme is chosen (Pizza, Bowls, Tacos, Indian, Chaos Mix) and a
dietary filter applied. The backend generates ten ingredients for the match — five
for each chef — and shows them to nobody. Chefs know the theme and the count, never
the items. This is the single most important rule in the source format: the
drafters are in the dark, and the referee holds the information.

**The auction.** The referee announces one ingredient. Both chefs bid upward in
real time — `1 → 2 → 3 → 5 → 7` — against a 10-second clock, from a budget of 10
coins. A chef concedes with one word: **Take it**. The winner pays the bid. When a
chef's budget hits zero, they are forced to take every remaining ingredient free,
which is exactly how both chefs end up with five.

**Gifting.** Once per round a chef may hand an ingredient to the other for free, or
offer a trade. In the source videos this is a weapon, not a kindness.

**Cooking.** Both dishes are assembled visibly from their five ingredients, in 3D.
The twist ingredient lands last, and it is the beat everyone reacts to.

**Voting.** The table votes once, anonymously, for the dish they would rather eat.
A vegetarian badge marks dishes that meet the filter so a filtered diner can vote
fairly. The dish with more votes wins the round; best of three rounds wins the
match. No guess-the-chef mode: the vote is about the dish, always.

## Phases

`Lobby → Deck → Auction (x10 items) → Plating → Vote → Round result`, repeated for
up to three rounds, then `Match result`.

## Tech

- **Server**: Node 22, Express, socket.io. Rooms held in memory — a party room dies
  with the evening, and there is no database to leak. Binds `0.0.0.0:$PORT`.
- **Client**: Vite + TypeScript PWA, 360px-first, touch only, no account state.
- **3D**: Three.js. Stylised low-poly kitchen, one recurring refereed character.
- **Venice APIs** (all server-side):
  - text — ingredient generation and the referee's taunt lines
  - image — ingredient art; a fast cheap model for the library, a premium model for
    the twist ingredient, cached by name
  - TTS — one recurring announcer voice, streamed to the client and lip-synced

## How this gets built

Noodle holds the backlog (`todos.md`) and the working method (`.agents/skills/`),
and it is the scheduler of record. Its own loop is **parked**: Noodle drives only
the Claude and Codex CLIs, Claude Code cannot talk to Venice at all, and Codex is
not wanted here.

Work is executed by Hermes subagents pinned to Venice models — `kimi-k3` as the
workhorse, `z-ai-glm-5-3-flash` for cheap stages — one backlog item at a time, each
verifying with `npm run typecheck && npm run build && npm test` before committing.
Railway gates every deploy on the same command, so nothing unverified reaches the
table.

## Non-negotiables

- Every secret lives server-side. The Venice key never reaches the browser.
- Two phones, one room, flaky wifi, no accounts, and it must be funny.
