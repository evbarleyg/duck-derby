# Phase 4 — Grand Prix Online: build notes, measurements, things Evan must do

Companion to `PHASE4-GRAND-PRIX.md`. Updated as milestones land.

## Status

| Milestone | State | Notes |
|---|---|---|
| M1 transport probe | built; **verified against the local relay only** | the cloud build sandbox cannot reach `*.supabase.co` (egress proxy answers 403 to CONNECT). Probe page + script are in the repo and deployed; run them against Supabase from any normal network (below). |
| M2 lobby | in progress | |
| M3 race wiring | — | |
| M4 hardening | — | |
| M5 load test | — | |

## Things Evan must do

1. **(Blocking for live verification from the build sandbox)** allow-list `aqguvjeqwjvuyfchldwq.supabase.co`
   (or `*.supabase.co`) in the Claude Code cloud environment's network settings. Until then every Supabase
   measurement has to be taken from a laptop/phone; the code paths are identical (same `openRoom()` seam).
2. Run the M1 probe against Supabase once (2 minutes, see below) and paste the RESULT line into this file.

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
