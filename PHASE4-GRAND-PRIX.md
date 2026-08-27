# Phase 4 — Grand Prix Online (live multiplayer over the internet, draft-night ready)

**This is the build order for the executor session. Begin executing on read.**

The league will decide its fantasy draft order by *driving*: every manager joins
a lobby from their own phone, over the internet (NOT same-room), steers their
own duck, watches from their own chase cam on their own screen, and the finish
order is the draft order. This is PHASE3's Grand Prix promoted from stretch
goal to the product. The requirement from Evan, verbatim in spirit: everyone
joining the lobby, connecting with their phones, using their own screens, and
having it be **relatively not buggy** on the one night it matters.

The deterministic seeded race is explicitly NOT the preferred result — it
survives only as the emergency fallback mode (see "Fallback" below).

## What already exists (do not rebuild)

- `world.html` renders the full course, 3D ducks/hats, chase/TV/free cameras,
  HUD, items, commentary, audio. The renderer consumes duck state
  `(s, lateral, speed, state)` per frame from "somewhere".
- **Tilt Trial** (`src/world3d/trial.js` + `src/world3d/input.js`) is the
  single-player half already shipped: a live 60 Hz sim driven by tilt/touch/
  keyboard input, with AI ducks using the phase-2 brains. Phase 4 is that sim
  fed by N remote players instead of 1 local player + AI.
- `vendor/qrcode.js` is already vendored for the join-by-QR lobby flow.
- Hosting: static site on Vercel (https://duck-derby.vercel.app), auto-deploys
  from `main`, CI-only workflow (`.github/workflows/ci.yml`). No build step —
  keep it that way.

## Infrastructure (already provisioned — real, verified, ready)

- Supabase project `duck-derby`, ref `aqguvjeqwjvuyfchldwq`, region us-west-1,
  on Evan's org. Config committed at `src/world3d/net/net-config.js`.
- Use **Realtime only**: broadcast + presence channels. No database tables, no
  auth, no RLS, no edge functions. If you find yourself writing SQL, stop.
- Verified 2026-08-27: websocket handshake against
  `wss://aqguvjeqwjvuyfchldwq.supabase.co/realtime/v1/websocket` returns 101
  with the committed key. (`GET /rest/v1/` returns 401 on this project by
  design — not a key problem.)
- Rate limits: defaults apply. The message budget below is designed to fit
  them. If the load test (M5) says otherwise, tell Evan — raising Realtime
  quotas is a dashboard setting on his account, not something you can reach.
- Client library: vendor `@supabase/supabase-js` the same way three.js was
  vendored (registry.npmjs.org works from the sandbox; cdn.jsdelivr.net does
  not): `npm pack @supabase/supabase-js`, copy the standalone UMD bundle
  `dist/umd/supabase.js` into `vendor/supabase/supabase.js`, load it with a
  `<script>` tag before the module imports, use `window.supabase.createClient`.
  Record the version in `vendor/supabase/VENDOR.md`. If the UMD bundle is
  absent in the current package, fall back to saving the single-file browser
  bundle from `https://esm.sh/@supabase/supabase-js@2?bundle` into the same
  vendor path as an ES module — either way the site stays CDN-free at runtime.

## Architecture: host-authoritative star over a relay

One player's device (the **room host**, normally Evan's laptop) runs the
authoritative live-sim at 60 Hz — `trial.js`'s sim generalized to N ducks whose
steer/boost/item inputs arrive from the network, with the AI brains driving any
duck whose player is disconnected or idle. Everyone else runs the renderer plus
**client-side prediction** for their own duck and **interpolation (~120–150 ms
buffer)** for the others. Items and collisions resolve on the host so hits are
consistent.

Three Realtime channels per room, to control fan-out:

| Channel | Publishers | Subscribers | Rate budget |
|---|---|---|---|
| `room:<CODE>` (lobby/control) | everyone | everyone | trivial: presence joins/leaves, ready toggles, config, countdown, race-over, rematch |
| `room:<CODE>:in` (inputs) | players | **host only** | per player ≤ 10 Hz, event-driven: send on change beyond a small epsilon, else a 250 ms heartbeat; payload `{t, steer, buttons}` — a few bytes |
| `room:<CODE>:out` (state) | **host only** | everyone | 12 Hz snapshots, compactly packed: per duck `s, lateral, speed, stateFlags` (~24 B) + item events; ≈ 400 B per message for 12 ducks |

Budget at 12 players + host + a spectator: ~120 input deliveries/s (single
subscriber) + ~12 × 14 ≈ 170 snapshot deliveries/s ≈ **300 deliveries/s
during a ~60 s race**, well inside Realtime defaults. Verify in M5, don't
assume.

Supporting mechanics:

- **Clock**: host is the time authority. On join, each client estimates its
  offset with ~5 ping/pongs through `:in`/`:out`; countdown and race start are
  scheduled in host-time.
- **Prediction/reconciliation**: apply your own input locally immediately;
  when a snapshot arrives, blend your duck toward the authoritative state
  (never snap unless divergence is large). Other ducks render from the
  interpolation buffer.
- **Reconnect**: on drop, the player's duck switches to AI autopilot on the
  host; on rejoin (same `?room=` link), control resumes with the next input.
  Phones will lock/background — this path is first-class, not an edge case.
- **Host loss (v1 policy)**: mid-race host disconnect voids the race — clear
  full-screen banner on every client, auto-return to lobby, race again. Host
  migration is v2; do not let it block draft night. In the lobby, the host can
  hand off host-ship explicitly before starting.
- **Wake lock**: `navigator.wakeLock` (with graceful absence) during lobby +
  race so phones don't sleep mid-race.

## Draft-night flow (the product)

1. Organizer opens the site → **Host a race** → gets a 4-letter room code
   (unambiguous alphabet — no 0/O/1/I), a QR (vendored qrcode.js), and a link
   `world.html?room=CODE`.
2. Managers open the link on their phones: enter name → claim a duck (palette
   + hat, identities from `assignLooks`) → ready toggle. Roster shows who's
   in, ready state, and a connection-quality dot (last-ping age).
3. Host sets: rule (`w`|`l` — winner or last place picks first), items on/off,
   best-of-N (default 1); GO enables when all present players are ready.
4. Synchronized countdown → race. Phones: tilt (with the existing iOS
   permission flow from Tilt Trial) / touch / keyboard, own chase cam. The
   host's screen (or any extra device joining as spectator) can run the TV
   auto-cut view.
5. Results overlay = **the draft order** under the chosen rule, with a
   results permalink for the league record. Rematch returns everyone to the
   same lobby.

Fairness for a driven race (from PHASE3): identical duck stats for everyone,
item tables keyed only on race position (already the shipped design), best-of-N
as a league option. Skill deciding a driven race is accepted and intended.

## Fallback (build it, hope to never use it)

A "Let the ducks decide" button in the lobby: host broadcasts
`{names, seed, startAt}` on the control channel and every client plays the
existing deterministic seeded race locally, chase cam on their own duck,
identical result everywhere, zero mid-race network traffic. Once the lobby
exists this is nearly free, and it is the emergency path if draft night's
internet melts. It is NOT the default and NOT the headline.

## Milestones — each independently verifiable, in order

- **M1 — Transport probe (kill the risk first)**: throwaway page + headless
  script proving two browser contexts exchange broadcast messages through the
  provisioned project at the budget rates; measure and record RTT
  distribution. If this fails, stop and report before building anything.
- **M2 — Lobby**: create/join/presence/ready/QR/config/host-handoff, as a
  state machine with a pure reducer (unit-testable). Playwright: 3 contexts
  join one room, roster converges, ready-gating works.
- **M3 — Race wiring**: host live-sim with remote inputs + AI fill, input
  coalescing up, packed snapshots down, prediction + interpolation, countdown
  sync, results. Playwright: host + 2 clients complete a race; every client
  displays the host's canonical finish order; no console errors.
- **M4 — Draft-night hardening**: reconnect/autopilot/resume, host-loss
  banner + lobby return, wake lock, connection dots, rematch, results
  permalink, fallback seeded mode, phone-Safari tilt permission path.
- **M5 — Load test**: 13 headless clients (12 input bots at full rate + host)
  through a complete 3-minute session: no message-loss-induced divergence,
  delivered rates within budget, stable memory, RTT/loss numbers written up.

## Testing bar ("relatively not buggy" is a contract)

- `npm run ci` stays green throughout; the existing 52 tests are untouchable.
- New unit tests: lobby reducer, input coalescing, snapshot pack/unpack
  round-trip, clock-offset estimator, room-code alphabet.
- Playwright multi-context integration tests as above (reuse the swiftshader
  flags from `tools/`); wire them into `npm run ci` only if runtime stays
  reasonable, otherwise a separate `npm run ci:net` that CI also runs.
- Manual phone checklist committed to this doc's companion
  (`PHASE4-NOTES.md`): iOS Safari + Android Chrome — join via QR, tilt
  permission, lock/unlock mid-race and regain control, results match the
  host's screen.
- No console errors on any tested path.

## Constraints

- Static files only, no bundler, no runtime npm deps — vendor everything
  (npm pack route; jsdelivr is blocked from the sandbox).
- Do not edit the 2D-game files (`index.html`, `styles.css`, `src/main.js`,
  `src/scene.js`, `src/draw-duck.js`, `src/sim.js`, `src/ducks.js`) or the
  existing tests. Do not break the existing `world.html` modes (seeded
  auto-race, Tilt Trial).
- New code in `src/world3d/net/` + a lobby UI module; tests in
  `test/world3d.net.*.test.js`; extend the `check` glob in `package.json`.
- Never commit `service_role` / `sb_secret` keys. The committed publishable
  key is intentional.
- 60 fps on a mid-range phone still holds: keep net work off the render path;
  no per-frame allocations in hot loops.
- Push small, reviewable commits to `main` as milestones land (each push
  auto-deploys); note anything Evan must do (dashboard settings, phone
  testing) in your commit messages and in `PHASE4-NOTES.md`.

## Definition of done

Twelve phones plus a host across different home networks complete a full
driven Grand Prix; every screen shows that player's own chase cam during the
race and the identical canonical draft order at the end; a mid-race phone
lock-and-return regains control; the fallback seeded mode works from the same
lobby; M1–M5 artifacts (tests + measured numbers) are in the repo; known gaps
listed in `PHASE4-NOTES.md`.
