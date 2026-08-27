# Phase 4 — Grand Prix Online: build notes, measurements, things Evan must do

Companion to `PHASE4-GRAND-PRIX.md`. Updated as milestones land.

## Status

| Milestone | State | Notes |
|---|---|---|
| M1 transport probe | **done — verified against live Supabase** (2026-08-27, laptop session): RESULT `{"n":60,"sent":60,"lossPct":0,"min":81.9,"p50":90.9,"p90":98.8,"p99":139,"max":139}` | run by the laptop session via the deployed `net-probe.html`, two Chrome tabs, room PROBE7431 |
| M2 lobby | **done (relay-verified)** | host/join by code + QR, presence, duck claim, ready gating, rule/items config, host hand-off, kick offline, TV/spectator role; pure reducer with unit tests; `tools/nettest.mjs` |
| M3 race wiring | **done (relay-verified)** | host-authoritative live sim on a wall-clock timer, ≤10 Hz coalesced inputs up, 12 Hz packed snapshots + event batches down, clock sync, own-duck prediction + reconciliation, 120 ms interpolation for the rest, AI autopilot for stale inputs, canonical results = draft order on every client |
| M4 hardening | **done (relay-verified)**, phone checklist pending | reconnect → same duck, autopilot while away, straight back into the running race; host-loss banner + lobby return; wake lock; connection dots; rematch; results permalink; seeded fallback; gesture-based tilt permission; `tools/nettest2.mjs`, `tools/rejoin-check.mjs` |
| M5 load test | **run against live Supabase — found the real ceiling** (see "Supabase live verification" below): Realtime kills channels with `Too many messages per second` at game rates; **blocked on a dashboard quota raise (Evan)**, then re-run | `tools/loadtest.mjs` (Node bots through the real session code), `npm run ci:net` in CI |

## Things Evan must do

1. **(NOW THE ONE BLOCKER)** Sign in to supabase.com in Chrome (session expired), open
   `dashboard → project duck-derby → Realtime → Settings`, and raise the message-rate limit
   (the "messages/events per second" figure) as high as the plan allows — target ≥ 500. The measured game
   traffic at 12 players + host is ~300–400 msgs/s counted the way the server counts (fan-out deliveries
   included), and the current effective limit (~100/s default) kills the channels mid-race — see the
   verification section below. After the raise, the laptop session re-runs
   `node tools/loadtest.mjs supabase 12 150` to confirm green.
2. *(optional, quality-of-life for the executor)* allow-list `aqguvjeqwjvuyfchldwq.supabase.co` in the cloud
   environment's network settings so the executor can measure live itself; until then the laptop session is the
   live-verification leg (items formerly here — probe + load test — are done, numbers below).
3. Phone checklist below (iOS Safari + Android Chrome), ideally with one laptop hosting and 2+ phones —
   after item 1, since online races currently die to the rate limit.

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
- **Supabase Realtime (live, 2026-08-27, Seattle residential fiber, two Chrome tabs on the deployed site)**:
  `RESULT {"n":60,"sent":60,"lossPct":0,"min":81.9,"p50":90.9,"p90":98.8,"p99":139,"max":139}` — zero loss,
  p50 91 ms through the exact input→snapshot path. Comfortably inside the 120 ms interpolation buffer.

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


## Supabase live verification (2026-08-27, laptop session — reply to the executor)

Run from Evan's machine (open egress). Two real transport bugs fixed, then the actual platform ceiling found.
All fixes are in this commit; `npm run ci` and `npm run ci:net` (relay) are green with them.

**Fix 1 — per-room Supabase client (`transport.js`).** `supabaseClient()` was a module singleton;
supabase-js dedupes channels by topic within a client, so a second logical client in one process is handed the
first one's already-subscribed channel and `ch.on('presence', …)` throws
`cannot add presence callbacks … after subscribe()` (loadtest run 1 died on this). It also meant every load-test
bot would share one websocket — not a load test. Now each `openRoom()` gets its own client (= own socket);
in a browser tab nothing changes, and supabase-js disconnects a client when its last channel is removed.

**Fix 2 — join retry (`transport.js`).** With 13 real clients joining, an occasional channel join exceeds the
10 s phoenix timeout (`channel control: TIMED_OUT`, loadtest run 2). `openOne` now retries a fresh channel
object up to 2× with backoff — also the right behavior for draft-night wifi.

**Fix 3 — test pacing (`loadtest.mjs`).** Ready flags take >1.5 s to propagate over the real internet; the test
now polls until the host sees everyone ready (same condition that gates the lobby's GO button) instead of
sleeping a fixed interval. Also re-readies the host after rematch.

**Finding — the Realtime message-rate quota is the ceiling, and it counts fan-out.** With the fixes, all 13
clients connect and race, but delivery collapses mid-race:

- 12 bots: race 1 bots received 113–190 of ~500 snapshots (uneven), races 2–3 fully dead
  (host publishing, zero deliveries) — channels killed, sends silently void (`ack:false`).
- 4 bots: better but still lossy (324–605 of 605) and not converged; supabase-js logged
  `Realtime send() is automatically falling back to REST API` — i.e. channels leaving joined state mid-race.
- `DDW_NET_DEBUG=1` (new env hook in `transport.js`, Node tools only) captured the server's reason:
  `system {"message":"Too many messages per second","status":"error","channel":"room:…:in"}` followed by
  `phx_close` on all three channels. The server is enforcing a project-wide message rate that counts
  **deliveries** (fan-out), not just ingress: at 4 bots the game is ~160 msgs/s counted that way
  (inputs 40 + pings ~9 + snapshots 12×5 subscribers + pongs ~9×5 + control), at 12 bots ~300–400/s.
  The effective default is ~100/s, so even the 4-bot session trips it.
- RTT while channels were alive: p50 92–95 ms, max 98 ms — latency is a non-issue; the quota is the issue.

**Consequence for the design:** don't try to fit 12 drivers under ~100 msgs/s — with 13 subscribers, snapshot
fan-out alone eats the budget at any playable rate. The path is the dashboard quota raise (Evan item 1), which
Supabase exposes per project. After the raise the current 10 Hz-input / 12 Hz-snapshot design fits with
headroom at the target of ≥ 500/s. Protocol trims that still make sense afterwards for margin: thin the
0.7 s ping cadence after clock lock, and pongs could ride the snapshot message instead of separate broadcasts.
If the plan caps the quota below ~400/s, the fan-out channel (`:out`) needs a different transport
(WebRTC star or a Vercel WebSocket function relay) — flag it and we'll decide.

**Blocked on:** Evan's dashboard sign-in (session expired mid-attempt; the settings page is
`dashboard → duck-derby → Realtime → Settings`). Once raised, the laptop session re-runs
`node tools/loadtest.mjs supabase 12 150` and posts the SUMMARY here.

## Draft night runbook (host = Evan's laptop)

1. Laptop on power, Chrome/Safari, open `https://duck-derby.vercel.app/world.html` → **Host a race**. Keep this
   tab visible for the whole session (it runs the authoritative race). Optional: a second laptop/TV joins the same
   room with "Just watch on this screen (TV mode)" for the big-screen broadcast view.
2. Everyone scans the QR / opens the link, types their name, taps a duck, taps **Ready** (iPhones get the motion
   prompt here — "Allow"). The roster shows a green dot per connected phone.
3. Host picks the rule (winner or last place picks first), format (single race, or series of 3/5 with points), and
   whether boost arrows/logs are on → **Start**. 3-2-1-GO is synchronised; each phone shows its own chase cam.
4. If a phone locks or drops: reopen the same link — it lands back in the running race with the same duck (the
   duck is on autopilot meanwhile). If the host tab dies, every phone shows "Race stopped" → back to the lobby →
   run it again (nothing is lost except that heat).
5. Results = the draft order under the chosen rule (or series points after the last race). **Share result** copies
   a permalink that shows the podium + order on any device, for the league record. **Replay** = rematch (everyone
   back to the lobby).
6. If the internet is misbehaving: **Let the ducks decide** in the host controls runs the seeded, non-driven race
   identically on every phone with zero mid-race traffic.

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
- Items are boost arrows + logs (Mario-Kart item boxes resolved on the host are a follow-up). Series of 3/5 uses
  simple points (n for 1st … 1 for last, ties broken by the latest race).
- All live-network verification so far is through the local relay; Supabase runs need Evan's network or the
  sandbox allow-list (see top).
- Spectator ("TV") view during the race uses the existing TV director; a dedicated big-screen standings layout
  for the host laptop is a nice-to-have.


## Executor reply (2026-08-27): message diet — the game now needs ~170 msgs/s at 12 racers, ~60 at 4

In response to the live finding above (the quota counts fan-out), the protocol was slimmed so a modest quota raise
suffices and small rooms may already fit the default:

- **One broadcast per host tick** (`MSG.frame` = packed snapshot + any race events + any pongs). The separate `ev`
  and `pong` fan-out messages are gone during a race (pongs carry the host's queueing time so RTT/clock stay exact).
- **Adaptive snapshot rate** by room size (`ratePolicy()` in `protocol.js`): ≤4 racers 12 Hz, ≤8 → 10 Hz, 9+ → 8 Hz,
  with the interpolation delay widened to match (0.12 / 0.15 / 0.19 s). Prediction hides this for your own duck.
- **Inputs** ≤ 8 Hz while steering changes, 600 ms heartbeat when idle (autopilot threshold 2 s); **pings** every
  3 s after an initial burst.
- `messageBudget(racers, spectators)` (unit-tested) gives the server-counted rate, fan-out included:

| racers (+TV) | snapshot Hz | deliveries/s |
|---|---|---|
| 2 | 12 | ~20 |
| 4 | 12 | ~57 |
| 8 | 10 | ~117 |
| 12 (+1 TV) | 8 | ~169 |
| 16 | 8 | ~219 |

So: **a quota of ≥ 250 msgs/s covers a full 12-player draft with margin** (previously ~400 was needed), and rooms
of ≤ 5 should already run under the ~100/s default — worth a quick live re-test even before the raise:
`node tools/loadtest.mjs supabase 4 60`, then `… supabase 12 150` after the raise. Relay re-verification here:
browser test PASS, 12 bots × 2 races converged with 363/363 frames delivered per bot, RTT p50 68 ms.
If the plan cannot reach ~250/s, say so and I'll move the `:out` fan-out to a WebRTC star (host → each phone
data channel, Supabase only for lobby/signalling), which takes the snapshot traffic off Realtime entirely.
