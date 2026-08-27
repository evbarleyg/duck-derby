# Phase 4 — Grand Prix Online: build notes, measurements, things Evan must do

Companion to `PHASE4-GRAND-PRIX.md`. Updated as milestones land.

## Status

| Milestone | State | Notes |
|---|---|---|
| M1 transport probe | built; **verified against the local relay only** | the cloud build sandbox cannot reach `*.supabase.co` (egress proxy answers 403 to CONNECT). Probe page + script are in the repo and deployed; run them against Supabase from any normal network (below). |
| M2 lobby | **done (relay-verified)** | host/join by code + QR, presence, duck claim, ready gating, rule/items config, host hand-off, kick offline, TV/spectator role; pure reducer with unit tests; `tools/nettest.mjs` |
| M3 race wiring | **done (relay-verified)** | host-authoritative live sim on a wall-clock timer, ≤10 Hz coalesced inputs up, 12 Hz packed snapshots + event batches down, clock sync, own-duck prediction + reconciliation, 120 ms interpolation for the rest, AI autopilot for stale inputs, canonical results = draft order on every client |
| M4 hardening | **done (relay-verified)**, phone checklist pending | reconnect → same duck, autopilot while away, straight back into the running race; host-loss banner + lobby return; wake lock; connection dots; rematch; results permalink; seeded fallback; gesture-based tilt permission; `tools/nettest2.mjs`, `tools/rejoin-check.mjs` |
| M5 load test | **done via relay**, Supabase run pending egress | `tools/loadtest.mjs` (Node bots through the real session code), `npm run ci:net` in CI |

## Things Evan must do

1. **(Blocking for live verification from the build sandbox)** allow-list `aqguvjeqwjvuyfchldwq.supabase.co`
   (or `*.supabase.co`) in the Claude Code cloud environment's network settings. Until then every Supabase
   measurement has to be taken from a laptop/phone; the code paths are identical (same `openRoom()` seam).
2. Run the M1 probe against Supabase once (2 minutes, see below) and paste the RESULT line into this file.
3. Run the load test against Supabase once from a laptop: `node tools/loadtest.mjs supabase 12 150` (Node ≥ 22,
   no install needed; it loads the vendored supabase-js). Paste the SUMMARY. If snapshots per bot come back well
   under ~12/s × race seconds, Realtime is throttling: raise the project's Realtime limits (dashboard → Realtime
   settings: events per second / concurrent) or tell me and I'll drop the snapshot rate to 10 Hz.
4. Phone checklist below (iOS Safari + Android Chrome), ideally with one laptop hosting and 2+ phones.

## M1 — transport probe

Files: `net-probe.html` (deployed with the site), `tools/netprobe.mjs` (headless, two browser contexts),
`tools/relay.mjs` (dependency-free WebSocket relay that mimics Realtime broadcast + presence for tests; optional
simulated latency/jitter), `src/world3d/net/transport.js` (the seam: `openRoom({kind:'supabase'|'relay', ...})`).

**Run it against Supabase, by hand (any two devices/tabs):**
- open `https://duck-derby.vercel.app/net-probe.html?role=echo&room=PROBE1&auto=1` on one device,
- open `https://duck-derby.vercel.app/net-probe.html?role=ping&room=PROBE1&auto=1&n=60` on another;
  the ping page prints `RESULT {"n":…,"lossPct":…,"p50":…,"p90":…,"p99":…}` (broadcast RTT through Realtime:
  ping on `room:PROBE1:in`, pong on `room:PROBE1:out`, i.e. exactly the input→snapshot path of the game).
- rate test: `?role=flood&secs=30` sends 10 Hz inputs + 12 Hz snapshot-sized payloads (what one player + the
  host emit); watch the echo page's counter and the Supabase Realtime dashboard for throttling.

**Headless (from a machine that can reach Supabase):**
```sh
npm run serve &                       # http://localhost:8080
node tools/netprobe.mjs supabase      # prints the RTT distribution, exits non-zero on failure
```

**Measured so far**
- Local relay with simulated 35 ms ± 12 ms one-way latency (sandbox, 2026-08-27): n=40, loss 0 %,
  RTT p50 71 ms · p90 85 ms · p99 92 ms — i.e. the probe/transport code itself adds ~1 ms.
- Supabase Realtime: _pending (see "Things Evan must do")_.

## Design decisions taken (so far)

- Transport seam with two implementations (Supabase Realtime / local relay) chosen by `?relay=ws://…` — all
  lobby/host/client code is transport-agnostic, and the Playwright integration tests in this repo run against the
  relay.
- supabase-js 2.112.4 vendored as the UMD bundle (`vendor/supabase/`), loaded with a plain `<script>`; only the
  Realtime client is used (`broadcast` with `self:false, ack:false`, `presence` keyed by client id on the control
  channel only). Each client subscribes only to the channels its role needs.
- Pure, unit-tested building blocks: room codes (unambiguous alphabet), clock-offset estimator (median of the
  low-RTT half), packed snapshots (integers, ~350 B for 12 ducks), input coalescer (≤10 Hz, change-driven, 250 ms
  heartbeat), snapshot interpolation buffer (120 ms render delay, ≤250 ms extrapolation), lobby reducer.

## Known gaps

- (M1) No Supabase numbers yet — sandbox egress.


## M2 + M3 — lobby and race wiring (2026-08-27)

`node tools/relay.mjs 8787 --latency=35 --jitter=12`, `npm run serve`, then `node tools/nettest.mjs 2`:
host + 2 guests in separate browser contexts → roster converges on all three, GO disabled until everyone is
ready, synced countdown, all three racing (guests steering by keyboard), host receives ~10 inputs/s per guest,
guests receive 12 snapshots/s, RTT ≈ 75 ms through the relay, and **every client shows the host's canonical
draft order**; no console errors. (Headless software-GL makes each page slow; the host sim runs on its own
timer so a slow or hidden host tab cannot slow the race.)

How it maps onto the brief: `net/session.js` (orchestrator: host + guest roles, clock sync, countdown at host
time, results/rematch/abort/fallback), `net/remote-race.js` (client view: interpolation buffer + own-duck
prediction, same shape as the Tilt Trial sim so the renderer/HUD are untouched), `trial.js` generalised to N human
drivers with AI autopilot when a player's input is stale (>1.2 s), `online-ui.js` (lobby panel), `world.html
?room=CODE` (join) / `?host=1` (host) / `&as=tv` (spectator), Host/Join buttons on the setup screen.


## M4 — draft-night hardening (2026-08-27)

- **Reconnect**: a phone that locks/reloads keeps its identity (per-tab id in sessionStorage, per-device in
  localStorage), re-enters with `?room=CODE`, the host re-sends the running race (`start` with its current clock),
  the client skips the ceremony and drops straight into the race; its duck was on AI autopilot meanwhile and the
  first input takes control back. Verified: `tools/rejoin-check.mjs` → "slot before/after reload: 1/1 … autopilot
  after input: false"; `tools/nettest2.mjs` covers the reload-lands-after-the-finish case (gets the result).
- **Host loss**: presence-leave of the host or 4 s without host data mid-race → full-screen "Race stopped" card on
  every client → back to the lobby (v1 policy: race void, run it again). Host hand-off in the lobby via the roster.
- **Wake lock** while in a room (re-acquired on visibility change). **Connection dots** from last-seen age.
- **Rematch**: host's Replay button = everyone back to the lobby, ready flags cleared.
- **Results permalink**: `world.html?gp=ROOM&names=…&order=…&times=…&rule=…` renders podium + draft order with no
  network; "Share result" / "Copy draft order" use it. Example from a test run:
  `/world.html?gp=RJKE&names=host~ann~bob&order=1,2,0&times=39.22,39.78,41.93&rule=w`.
- **Fallback** ("Let the ducks decide"): host broadcasts names + seed + start time; every client runs the seeded
  engine locally with the chase cam on its own duck; verified identical seed/names/order on all clients.
- **Tilt permission**: requested inside the Host / Join / Ready button handlers (user gestures), which is what iOS
  requires; touch-halves and arrow keys always work as well.

## M5 — load test (2026-08-27, relay in the sandbox)

`node tools/loadtest.mjs relay 12 150` — 12 bot players (Node, real `session.js`, wandering steer at the full
10 Hz input budget) + host, three back-to-back ~54 s races with rematch between:

| race | host inputs in | snapshots out | snapshots received per bot (min–max) | RTT p50 / max | converged |
|---|---|---|---|---|---|
| 1 | 4248 | 517 | 517–517 | 71 / 76 ms | yes |
| 2 | 4149 | 509 | 509–509 | 70 / 75 ms | yes |
| 3 | 4192 | 516 | 516–516 | 72 / 77 ms | yes |

≈ 100 input deliveries/s to the host + 12 Hz × 13 snapshot deliveries ≈ 260 deliveries/s during a race — the
budget in the brief. Heap for all 13 clients in one Node process: 10.6 → 26 MB over three races (per-race event
logs are kept for the results screen; a browser holds one client). `npm run ci:net` runs a 4-bot version in CI.
**Supabase numbers pending** (item 3 above).

## Manual phone checklist (please tick and note device/OS)

- [ ] iPhone Safari: open the room link from the QR → name → duck → Ready; tilt prompt appears on Ready; steering
      by tilt works in the race; touch left/right halves also steer.
- [ ] Android Chrome: same.
- [ ] Lock the phone for ~5 s mid-race, unlock: the page reconnects (or reload the tab) and you have control again
      within a couple of seconds; your duck kept its number/colour.
- [ ] Host laptop: TV view shows everyone; results match every phone; "Share result" link opens the same podium
      on a device that wasn't in the race.
- [ ] Kill the host tab mid-race: phones show "Race stopped" and return to the lobby.
- [ ] "Let the ducks decide": every phone shows the same seeded race and the same draft order.
- [ ] 20-minute session with 6+ phones: no tab crashes, phones don't sleep (wake lock), battery/thermal OK.

## Known gaps (v1)

- No host migration mid-race (by design for v1: race is voided and re-run).
- Best-of-N is in the lobby state but has no UI yet; items are boost arrows + logs (Mario-Kart item boxes on the
  host are a follow-up).
- All live-network verification so far is through the local relay; Supabase runs need Evan's network or the
  sandbox allow-list (see top).
- Spectator ("TV") view during the race uses the existing TV director; a dedicated big-screen standings layout
  for the host laptop is a nice-to-have.
