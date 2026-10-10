# Budget Draft engine

`server/draft/engine.ts` is a pure state machine. It never schedules a timer,
reads the clock, generates a hand, performs I/O or sends a socket message.

## Boundary

- `createDraft(hands, now)` validates two dealt hands using `parseHands` and
  starts round one with ten coins per chef. It copies the canonical ingredients,
  interleaves the two hands and puts both twists at the end of the reveal queue.
  Overlapping canonical ingredients are allowed by the generator; round-scoped
  slot identifiers distinguish copies.
- `reduce(state, action)` returns a detached next state. An invalid transition
  throws `DraftError` with a machine-readable `code`, leaving the input unchanged.
  The action switch is exhaustive at compile time.
- `publicState(state)` returns a detached public snapshot. **Never broadcast the
  complete `DraftState` envelope:** its `private.remaining` queue is server-only.
  No future round is preloaded. A reveal removes exactly one item from the private
  queue; only that item and previously revealed items enter the public state.
- `now` is an injected safe, non-decreasing millisecond clock reading. The game
  layer, not a client-provided timestamp, supplies it. The clock does not tick
  inside the engine.

## Actions

| Action | Meaning |
|---|---|
| `reveal` | Referee announces the next item. Opens bidding or records a forced free award. |
| `bid` | Current chef bids a whole number strictly above the standing bid, within their remaining purse. Resets the ten-second clock and passes the turn. |
| `take-it` | Current chef concedes. The other chef receives the item and pays the standing bid. |
| `timeout` | Game layer records expiry using the current chef, item `slot`, `deadline` and clock reading. Stale/early notifications fail. |
| `gift` | Chef transfers an owned, revealed `slot` for free between auctions. The recipient must have space. |
| `trade` | Chef offers an owned `give` slot for the opponent's revealed `receive` slot. |
| `respond-trade` | Recipient accepts or rejects the pending trade. Acceptance swaps the two items without transferring coins. |
| `round-result` | Trusted voting/referee layer supplies the round winner after plating and any pending trade. |
| `next-round` | Trusted game layer supplies fresh hands after a round result. Resets budgets, items, exchange allowance and clock; retains scores. |

Authenticate and map sockets to chef seats outside this module. Referee actions
(`reveal`, `timeout`, `round-result`, `next-round`) are not client-authorized
commands. In particular, a chef must not be able to declare their own vote result
or replace the private deck. The engine validates lifecycle and data, not socket
identity. When integrating a shot clock, read the latest state before reducing
its callback and retain both the item's slot and the turn's deadline.

## Spec edge cases resolved

The locked design describes the format, but does not define these cases:

- **Five-item cap versus “every remaining ingredient.”** A zero-coin chef takes
  the next items free until their dish reaches five. Once a dish is full, all
  further revealed items go to the other chef free. Forced items are still
  revealed individually, not leaked in a bulk assignment.
- **Cannot afford a counterbid.** If the opponent cannot strictly exceed a bid,
  the bidder wins immediately and pays that bid. Being unable to outbid is not
  the same as being broke: the loser does not receive the contested item free.
- **Opening turn and price.** Chef One opens each contested item at a standing
  price of zero. A concede or timeout before the first bid gives the other chef
  the item free. Each accepted bid starts a new ten-second turn. At the exact
  deadline player bidding/conceding is closed; an explicit timeout resolves it.
- **Gift/trade scope and timing.** There is one shared optional gift or trade
  offer per round, not one per chef. Transfers happen between auctions or at
  plating, never while an item is contested. A rejected trade still uses the
  allowance. A pending trade blocks the next reveal and the round result until
  answered. A gift into a full dish is rejected; a trade preserves five items.
- **Best of three.** First to two round wins ends the match, so a sweep ends in
  round two. The engine consumes a trusted winner rather than implementing votes
  (backlog item 9). It does not invent a winner for tied votes: the voting layer
  must resolve a tie before sending `round-result`.

The generated source hands each contain one twist, but free bidding/transfers
can put both twists into the same final dish. The engine preserves free bidding
and reveals both twists last; guaranteeing one twist per final dish would need
an additional auction restriction not stated in the locked rules.

## Room integration (items 15–16)

`server/game.ts` owns a `GameSession` per canonical room code. Dealt hands and
`DraftState` are private fields; the only state accessor is `publicState()`,
which delegates to the engine's detached public projection. Starting consumes
stored hands into the engine. The room itself and `room:state` never hold hands.
The engine and its public surface remain unchanged.

### Setup receipt

`POST /api/rooms/:code/hands` accepts `{ deckId, vegetarianOnly?: boolean }`.
It calls the existing server-side `generateHands`, using Venice with its validated
fallback. Success returns **only** `{ ok: true, vegetarianOnly }`: no ids, names,
hands, or counts derived from content. Unknown rooms return 404, fewer than two
seated chefs return 409, and malformed options/unknown decks return 400.
Generation is serialized per session; in-flight generation and an active draft
refuse a redeal. Generation failures use a generic message, never a model or hand
validation message. Deleted sessions cannot be resurrected by late generation.
This setup route is currently room-code scoped, not socket-authenticated; host-only
HTTP setup authorization and abuse/rate limits are follow-ups.

### Wire protocol and authority

Every request carries `code`. Chef requests also carry `chef` (`chefOne` or
`chefTwo`); the server verifies it against the seat owned by the sending socket.
No wire request is trusted to supply a time, deadline, hands or timeout action.

| Event | Additional request fields | Authority |
|---|---|---|
| `draft:start` | none | Room host only; requires stored hands and two chefs |
| `draft:reveal` | none | Room host only |
| `draft:bid` | `chef`, `amount` | Socket owning that chef seat |
| `draft:take-it` | `chef` | Socket owning that chef seat |
| `draft:gift` | `chef`, `slot` | Socket owning that chef seat |
| `draft:trade` | `chef`, `give`, `receive` | Socket owning that chef seat |
| `draft:respond-trade` | `chef`, `accept` | Socket owning that chef seat; engine requires the recipient |

For now **host-is-referee**: the first joined socket is the host and also
`chefOne`, preserving the existing lobby seating until item 14 is decided.
The second chef cannot start/reveal; table and unseated sockets cannot perform
chef actions. Seat identities do not shift when another player disconnects.
A new occupant may fill a vacant chef seat, but does not inherit host authority.
A socket may sit in only one room. Host reconnection/authority transfer is not
implemented; a disconnected host cannot be impersonated by the next player.

Accepted actions broadcast `draft:state` to that room only, containing exactly
the engine's `publicState()`. Refusals send only the sender `draft:error` with
`{ code, message }`; engine codes/messages are preserved, authorization uses
`invalid-action` (host) / `invalid-chef` (seat), and missing setup uses `wrong-phase`.
Handlers reduce synchronously; async generation is locked until complete.

### Server clock and deletion

A reveal or accepted bid schedules `setTimeout` for the engine deadline. The
session clears/replaces the previous timer after each accepted transition.
Its callback checks timer identity, current slot, turn and deadline, then reduces
`timeout` with the **current** state's slot/turn/deadline and a server clock reading.
Clock readings are clamped non-decreasing if the wall clock moves backwards;
early callbacks reschedule. Clients cannot forge an expiry or extend a turn.
The resulting award is projected and broadcast just like a player transition.
RoomRegistry deletion disposes all private state and timers; the last departure
also deletes its room. HTTP server shutdown disposes all sessions' timers.

### Secrecy verification

Real-socket coverage captures every emitted event on both chefs throughout setup,
a full ten-item round, refusals and disconnects, plus the HTTP hands receipt.
A deterministic **real generator** deal uses ten distinct ids/names to prevent
shared catalog copies from masking a leak. The walker checks keys, string values
and serialized JSON against each not-yet-announced ingredient at that event.
Mutation verification temporarily included the private queue in `publicState()`:
the test failed on `draft:state before reveal 0` containing `pizza-dough`. Removing
the mutation restored a passing test. No mutation is committed.

## Follow-ups

Connect anonymous voting (item 9), including a tie policy, trusted round results
and new-round generation. Decide how to resolve a pending trade when its recipient
disconnects, host reconnect/transfer, and whether opening turns should alternate
or twist ownership should be constrained. Wire public-state replay for late joiners
and the mobile auction UI (item 17); host seating remains item 14.
