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
| 14 | Demo mode | One-phone director mode: server-seeded virtual chefs and diners, auto-bid rival, and host-cast ballots. Same rules, no second phone. |

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

## Votes

- **Who:** table seats only. With no table seats, both chefs vote, including for
  their own dish. Eligibility is frozen when the host opens voting. Stable seat
  identity is the registry's socket-bound player id, never name/colour/list index;
  the sender must still be seated in this room. No reconnect identity is added.
- **When:** the engine must report `plating`, with two five-item plates, no auction
  and no pending trade. `match-result` cannot gate voting: it requires prior vote
  results. Opening locks dishes against further exchanges. One ballot each;
  duplicates/changes throw typed errors. All eligible ballots automatically close
  the vote; missing/disconnected voters leave it open (no invented auto-ballot).
- **Anonymous:** only `tally` is broadcast: fixed-order dish labels/ingredients,
  vegetarian flags/counts, aggregate total, phase, winner and tie. No voter ids,
  names, colours, keys, eligibility list or arrival ordering. Chef names label
  dishes, never ballots. Intermediate votes cause **no public event/count change**;
  the UI receives one final live aggregate batch. This takes precedence over
  per-arrival live counting, which leaks votes. Sender-only receipts are `{ ok:
  true }`; errors are sender-only. Single-voter/unanimous results inherently reveal
  preferences by arithmetic; anonymity cannot hide that while publishing counts.
- **Dietary:** vegetarian iff **every** final plate ingredient has
  `vegetarian === true`. Both cards and tally report the badge. Mixed/all-meat
  dishes explicitly say they contain meat or fish.
- **Ties:** equal counts finish as a shared tie (`winner: null`), no random/host
  tie-break or revote. No fabricated winner is fed into the draft's `round-result`.
  Match scoring/new-round generation and late-join replay remain separate work.

Unit, real-socket and real-browser coverage accompanies the vote. The socket
walker fails if a private voter id/name/colour appears in any ballot-phase event;
a temporary `voterId` projection mutation proved the assertion fails, then was
removed. `tests/vote.browser.mjs` covers waiting/open/locked/winner/tie and measures
zero overflow/sub-44px targets at 320/360/390/414/768/1280px; a deliberate 5px
overflow proves the detector fires. Run with installed `PLAYWRIGHT_MODULE` and
the built app's `VOTE_TEST_URL`.

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
and it is the scheduler of record. Its own loop is **parked**, for a measured
reason: Noodle drives only the Claude and Codex CLIs, Claude Code cannot talk to
Venice at all (no `/v1/messages`), and Codex can carry the Venice-hosted Claude
models but not the ones this project runs on — Venice's `/responses` returns
`status=incomplete` with empty output for `kimi-k3`, and `glm-5-3-flash` hangs
indefinitely through it. A loop whose cook cannot complete a file write is worse
than no loop, so the backlog is driven rather than spun.

Work is executed by Hermes subagents pinned to Venice models — `kimi-k3` as the
workhorse, `z-ai-glm-5-3-flash` for cheap stages — one backlog item at a time, each
verifying with `npm run typecheck && npm run build && npm test` before committing.
Railway gates every deploy on the same command, so nothing unverified reaches the
table.

## Non-negotiables

- Every secret lives server-side. The Venice key never reaches the browser.
- Two phones, one room, flaky wifi, no accounts, and it must be funny.
