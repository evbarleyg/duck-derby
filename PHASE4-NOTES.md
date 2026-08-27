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

1. ~~Raise the Realtime message-rate limit~~ **CHECKED 2026-08-27 (laptop session, Evan's dashboard): NOT
   RAISABLE on the free plan.** `Realtime → Settings` shows `Max events per second: 100` and
   `Max presence events per second: 20`, both locked behind "Spend cap needs to be disabled to configure this
   value — Upgrade to the Pro plan first". So the ceiling is hard at 100 events/s (fan-out counted) unless the
   org goes Pro. **DECISION NEEDED (Evan) — pick one:**
   - **(a) Upgrade the Supabase org to Pro** (~$25/mo) and raise the caps → current netcode ships as-is,
     laptop session re-runs the 12-bot test to confirm. Simplest, costs money for a duck game.
   - **(b) Keep free Supabase for lobby/signaling only and move race traffic (inputs + snapshots) to WebRTC
     data channels**, host-authoritative star per the PHASE3 table: lobby joins/roster/countdown stay well
     under 100 events/s; the race path becomes peer-to-peer with the host. Known risk: ~10 % of connections
     need a TURN fallback (needs a free TURN provider or accepts "hotspot fallback" guidance on draft night).
     Most work for the executor, zero recurring cost, best latency.
   - **(c) Race traffic through a Vercel WebSocket function relay** (Fluid Compute holds WebSockets; likely
     needs marketplace Redis as an instance-bridging bus). Middle ground; new moving parts on Vercel.
   The executor should weigh in with its preference in this file; Evan calls the money question.
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

## BUG — live 2-tab repro of Evan's phone report (2026-08-27, laptop session, prod @ 932d0b8)

Evan (real iPhone): "I joined the race but it looked like a different race than what was on my computer and
when I started the computer race it didn't start the phone race." Reproduced exactly with two Chrome tabs on
duck-derby.vercel.app — TWO distinct draft-night blockers:

**Bug 1 — cold first load of a `?room=CODE` link falls through to the local attract/fly-through race instead
of the join lobby.** Tab 2 opened `world.html?room=MRWP` for the first time → after "Inflating ducks…" it went
straight into the course fly-through camera (no lobby panel, no name entry, never joined the channel), i.e.
"a different race" on the phone. Reloading the SAME URL then showed the correct join panel ("GRAND PRIX
ONLINE · ROOM MRWP / Connecting…"). A phone scanning the QR is always a cold load, so this hits every
first-time joiner. Likely a race between the intro/attract flow starting and the online-join bootstrap
winning control after asset load; the `?room=` path needs to hard-gate the intro before anything else runs.

**Bug 2 — the Grand Prix host lobby auto-started a solo race with nobody ready.** Host tab: clicked "Host a
race" (room MRWP, roster only "Duck fan HOST YOU · not ready", button said "Waiting for: Duck fan"), then no
further interaction. ~45 s later the host tab had run a full 1-duck race and landed on the results permalink
`?gp=MRWP&names=Duck+fan&order=0&times=39.78&rule=w`, abandoning the room (the joiner then hangs at
"Connecting…" forever). Prime suspect: the seeded flow's "Start together (45 s lobby with a join QR)" timer
(checkbox was on in the setup screen) leaking into Grand Prix hosting. The GP lobby must never auto-start,
and host-side results/permalink navigation must not tear down the room while guests are connected.

Repro steps for both: (1) laptop tab: `/world` → Host a race → do nothing; (2) second device/tab: open the
room link cold → observe fly-through instead of lobby; (3) wait ~45 s → observe host solo-race + permalink.
No relevant console output was captured (app logs are quiet on this path — worth adding a `[net]` log line on
join-mode entry and on any auto-start trigger while debugging this).

## BUG — finish audio loops forever on the results screen (Evan, real playthrough 2026-08-27)

Evan, playing the seeded race on his Mac: "there's sort of a percussive sound for finishing that loops
forever at the end." Some finish-time percussion (confetti cannon / fireworks / photo-finish sting) never
stops once the results screen is up. Needs the finish stingers to be one-shots and/or the race audio loops to
be released on entering results.

Meanwhile the seeded league flow was verified end-to-end live on prod by the laptop session (names+seed link →
"pick your duck" self-select screen → 35 s synchronized countdown with Copy link → full race → DRAFT ORDER
results + podium + share). That flow is what the league is testing with today; it ships. The pick-your-duck
screen is exactly the "select yourself on login" experience — no extra feature needed.

## Small ask — port `look.chesty` to the 3D ducks

`assignLooks()` now sets `chesty: true` for the league member named Connor (league easter egg, Evan's
request) and the 2D renderer draws championship front plumage (`drawChest` in `draw-duck.js`) — two proud,
comically ample breast lobes with a breathing swell. Please give the 3D duck builder (`ducks3d.js`) the same
treatment when convenient: an exaggerated puffed-chest geometry keyed off `look.chesty`, cosmetic only.

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


## Executor follow-up (2026-08-27, later): WebRTC star takes the race traffic off Realtime

Built the contingency rather than wait on the quota: `src/world3d/net/rtc.js`. In the lobby the host opens an
`RTCPeerConnection` to every participant (signalling = three small messages each over the control channel; public
STUN, no TURN). During the race:

- frames (snapshot + events + pongs) go host → phone over an **unordered, no-retransmit data channel**; inputs go
  phone → host the same way;
- a phone whose data channel is up **leaves the Realtime `:out` channel** (`transport.pauseState()`), so it no
  longer counts in the broadcast fan-out; if its link drops it re-joins the channel within ~1 s and the host resumes
  broadcasting for it (the host broadcasts only while someone racing/watching is not reached by a data channel);
- peers that cannot connect (symmetric NAT on some cellular carriers, no TURN) simply stay on the Realtime path —
  per phone, automatically. `?rtc=0` forces the old behaviour for A/B testing.

Effect on the quota: with all phones linked, Realtime carries only the lobby, signalling, roster heartbeats and
3-second pings — a few messages per second regardless of player count. With k phones unlinked it is the message-diet
budget for k subscribers (e.g. 2 stragglers at 8 Hz ≈ 20 msgs/s). Verified here (Chromium, relay for signalling):
host `rtcPeers: 2`, guests `rtcIn 76/76 via rtc`, identical results, reload-mid-race rejoin still lands in the same
race with control, permalink + seeded fallback unchanged, no console errors. Node bots have no WebRTC, so
`tools/loadtest.mjs` keeps measuring the pure-Realtime path (worst case).

What this needs from the live leg: nothing new — the existing phone checklist covers it (two phones on different
networks joining the deployed site is the real STUN test). If a phone shows `via: relay` in
`__duckWorld.session().rtcLinked === false`, it fell back; the game still works for it through Realtime.


## Executor's recommendation on the quota decision (2026-08-27)

**Take (b) — it is already built and on `main` (`9e8cfa0`, see "WebRTC star" above), so the decision costs
nothing to try first; keep (a) Pro as the one-click safety net for draft night if the phone test shows more than
one or two phones unable to link.**

Why, with numbers against the hard 100 events/s cap (fan-out counted):

| situation (12 racers + host) | Realtime events/s | fits 100/s? |
|---|---|---|
| everything on Realtime, original protocol | ~350 | no |
| everything on Realtime, slimmed protocol (`8733ae3`) | ~170 | no |
| WebRTC star, all phones linked | ~5 (roster heartbeat, 3 s pings, signalling) | yes, 20× headroom |
| WebRTC star, 2 phones unlinked (symmetric NAT, no TURN) | ~5 + 8 Hz × 2 + their inputs ≈ 35 | yes |
| WebRTC star, 5 phones unlinked | ~90 | marginal |
| ≤ 5 racers all on Realtime (small league / all unlinked) | ~57–75 | yes |

Lobby, countdown, results, rematch and the seeded fallback are all low-rate control traffic and were never the
problem. Presence is capped at 20 events/s: joins/leaves only, fine.

So the remaining risk in (b) is exactly "how many phones fail to open a data channel to the host laptop". STUN-only
succeeds for typical home wifi and most carriers; symmetric NAT (some cellular, some corporate wifi) needs TURN.
Mitigations, cheapest first:
1. `NET_CONFIG.iceServers` now accepts a TURN entry (`net-config.js` has the template) — a free TURN tier
   (Metered/OpenRelay, Cloudflare, ExpressTURN) covers a 12-phone night many times over. If Evan drops credentials
   there, unlinked phones should go to ~0.
2. Draft-night guidance already works without TURN: a phone that shows no `P2P` tag in the host's roster can switch
   wifi ↔ cellular and re-join; and up to ~4 unlinked phones still fit the free quota anyway.
3. If the two-phone test shows P2P failing broadly (e.g. the host laptop itself is behind a symmetric NAT), flip to
   (a) for the night — no code change, the Realtime path is still there and the slimmed protocol needs ~170/s.

(c) (Vercel WebSocket relay) buys nothing over (b)+(a): more moving parts, still a paid tier for sustained
sockets, and worse latency than P2P.

**What I need from the live leg now:** the two-phone test on the deployed site with one laptop hosting —
confirm the roster shows `P2P` for both phones (or `__duckWorld.session().rtcLinked === true` on the phone), race,
lock/unlock one phone mid-race. Then, optionally, TURN credentials into `net-config.js`.


## Executor response to the 2-tab bug report (2026-08-27)

I could not reproduce either symptom headlessly (returning-user profile with "Start together" on + stored roster,
host idles 90 s, cold-loaded guest; relay transport and also with Supabase unreachable) — the host stays in the
lobby and the cold guest lands in a connected lobby every time (`tools/nettest3.mjs` now encodes exactly this and
passes). So the trigger is something only the live Supabase path produced. The permalink in bug 2
(`gp=MRWP&names=Duck+fan&order=0&times=39.78`) is what a client writes when it receives an **`over` for a 1-duck
race** (a results screen is shown from the message even without having raced — that looked like "the host ran a
solo race"). An `over` can only come from a host sim, so *some* host instance in room MRWP ran a 40 s race; the
host tab itself could not have (GO was disabled — nobody ready). My best guess is a second host-ish client in the
same room (an earlier tab/test still attached to MRWP, or the REST fallback echoing) — which the code accepted
because control messages were not sender-checked. Bug 1 ("fly-through instead of lobby") is consistent with the
same stray traffic: a `start`/`over` arriving at the freshly joined phone hides the lobby panel and switches the
camera, and my lobby used the fly-through camera as its backdrop, so "no panel" looked like "a different race".

Changes in this push (defence in depth, since the exact trigger isn't reproducible here):

- **Control messages are now signed with the sender (`from`) and checked**: guests act on
  `start / over / rematch / abort / fallback / config / handoff / kick / roster` only if they come from the host they
  know; the host ignores any `start`/`over` (it never needs them) and logs the attempt.
- **Nothing from the seeded flows can run while online**: `goOnline()` clears the "start together" timer state and
  the shared-link flag; `startRace()` refuses (and logs) any local start while in a room unless it is the online
  start or the explicit "let the ducks decide" fallback; the seeded lobby branch is additionally gated on
  `!state.online`.
- **Lobby backdrop is the static menu camera**, not the course fly-through, so a lobby can never be mistaken for
  a running race; the panel scrolls to top when shown.
- **`[net]` console lines** (as requested): online mode entry, room joined/hosting + transport, start received
  (with seconds-to-go), host starting race / race over / fallback, and every ignored message with its sender.
  Filter the console on `[net]`.
- Boot can no longer stall on `renderer.compileAsync` (4 s cap) — a cold shader cache on a phone GPU was the one
  first-load-only code path I could find.
- `tools/nettest3.mjs`: cold-load guest must sit in a connected lobby with the menu camera; idle returning-user
  host must still be in the lobby (URL `?room=`) after 70 s. PASS here, along with nettest/nettest2/rejoin-check.

If it happens again on prod, the `[net]` lines will say which message arrived from whom — please paste them.


**Fixed (executor, same day):** the "percussion that loops forever" was the procedural music bed left running at
results intensity (kick + clap, no melody at that level) plus fireworks booms keyed to a finish time that live modes
don't have. Now: a 4–7 s outro on the results screen, then the music stops (fade), fireworks stop after 12 s of
results, the menu is silent; Replay / seek / a new race restart the music.
