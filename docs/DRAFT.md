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

## Follow-ups

Wire the engine into a server-owned room lifecycle with authorized reveals,
serialized action dispatch, server-supplied clock readings and expiry callbacks
(backlog items 15–16). Connect anonymous voting (item 9), including a tie policy.
Decide how to resolve a pending trade when its recipient disconnects, and whether
opening turns should alternate or twist ownership should be constrained.
