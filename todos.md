# Todos

<!-- next-id: 13 -->

Working order matters: bootstrap the skeleton first, then the join flow and the
Venice service layer, then gameplay, then art and the avatar, then polish and
deploy. Read `docs/DESIGN.md` before starting any item.

## Inbox
1. [x] Harden the build harness: the Railway build gate runs typecheck, build and tests before any deploy, plus socket and bundle smoke coverage ~small #bootstrap
2. [x] Room + barcode join: create a room with a 4-letter code, render a QR code, let players join with name and colour, no accounts or passwords anywhere ~medium #join
3. [x] Venice service layer: server-side-only client for text, image and TTS using the key from the environment, with timeouts, retries and a /api/venice/health probe ~medium #venice
4. [x] Ingredient generation: from a deck, a vegetarian-only filter and one cross-cuisine twist, generate 5 ingredients per chef as strict validated JSON ~large #gameplay
5. [ ] Ingredient art library: a build script that renders the curated canonical ingredient set with a fast image model and caches them as static files ~medium #art
6. [ ] Live art for the cross-cuisine twist ingredient using a premium image model, cached by ingredient name so a repeat never regenerates ~medium #art
7. [x] Draft engine: 10 items, 5 per chef, 10 coins, ascending bids with a 10 second shot clock, Take It concede, forced free take when a chef is broke, single gift or trade per round ~large #gameplay
8. [ ] AI referee avatar: a 3D Three.js character that announces each ingredient with a Venice TTS voice and real lip sync driven by the audio ~large #avatar
9. [ ] Vote phase: one anonymous best dish vote for the whole table, with a vegetarian badge on dishes so filtered diners can vote fairly ~medium #gameplay
10. [ ] 3D kitchen staging: full Three.js scene, dishes assembling from the drafted ingredients, tasteful art direction at 60fps on a mid-range phone ~large #art
11. [ ] PWA polish: install prompt, offline shell, haptics, sound design, reduced-motion fallbacks ~medium #polish
12. [x] Deploy to Railway: single service, environment variables, healthcheck, public URL ready for a party ~small #deploy
13. [x] Triage the npm audit findings deliberately: fix what is reachable, pin or document what is dev-only. Do not run `npm audit fix --force` ~small #security — closed by upgrading vitest 3.2.7 → 5.0.3 (all 118 tests pass unchanged); npm audit now reports 0 vulnerabilities
14. [x] Host seating: decide whether the host occupies seat 1 as a chef or spectates. Today the host is seat 1 and is therefore always a chef, which surprises a host who only wanted to run the room ~small #gameplay
15. [x] Reveal-phase state machine: own hand persistence and the single authorised reveal broadcast, so a hand cannot leak into room:state before the referee calls it ~medium #gameplay
16. [x] POST /api/rooms/:code/hands: a thin route over the existing pure `generateHands` surface, once draft state exists to attach it to ~small #gameplay
17. [x] Mobile auction UI: bidding buttons (raise, Take it), the 10-second shot clock ring, live coin purses, the reveal beat and the plate view, thumb-friendly at 360px, driven only by the public draft state ~large #ui
18. [x] Round reveals can repeat a name: both chefs may be dealt the same core ingredient, so the same ingredient is announced twice in one round and reads like a bug on screen. Exclude cross-hand duplicates at deal time, or label the owner ~small #gameplay
