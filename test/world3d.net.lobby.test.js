import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialLobby, reduce, canStart, racers, freeSlot, rosterMessage, pickOrder, connQuality, seriesStandings, lineup, nameOf, seatCid, isSeatCid, ROLES } from '../src/world3d/net/lobby.js';

const L0 = () => initialLobby({ code: 'ACDE', hostCid: 'host', meCid: 'host', now: 0 });

test('join auto-claims slots in order, spectators get none, ready gating works', () => {
  let s = L0();
  s = reduce(s, { type: 'hello', cid: 'host', name: 'Evan', now: 1 });
  s = reduce(s, { type: 'hello', cid: 'p1', name: 'Ann', now: 2 });
  s = reduce(s, { type: 'hello', cid: 'p2', name: 'Bob', now: 3 });
  s = reduce(s, { type: 'hello', cid: 'tv', name: 'Big screen', role: ROLES.spectator, now: 4 });
  assert.equal(s.players.host.role, ROLES.host);
  assert.deepEqual(racers(s).map((p) => [p.cid, p.duck]), [['host', 0], ['p1', 1], ['p2', 2]]);
  assert.equal(s.players.tv.duck, -1);
  assert.equal(canStart(s), false);
  s = reduce(s, { type: 'ready', cid: 'host', ready: true, now: 5 });
  s = reduce(s, { type: 'ready', cid: 'p1', ready: true, now: 5 });
  assert.equal(canStart(s), false, 'p2 not ready');
  s = reduce(s, { type: 'ready', cid: 'p2', ready: true, now: 6 });
  assert.equal(canStart(s), true);
  // rename keeps the slot
  s = reduce(s, { type: 'hello', cid: 'p1', name: 'Annie', now: 7 });
  assert.equal(s.players.p1.duck, 1);
  assert.equal(s.players.p1.name, 'Annie');
});

test('claims: cannot take a slot held by someone online; can take one held by an offline player', () => {
  let s = L0();
  s = reduce(s, { type: 'hello', cid: 'a', name: 'A', now: 1 });
  s = reduce(s, { type: 'hello', cid: 'b', name: 'B', now: 1 });
  s = reduce(s, { type: 'claim', cid: 'b', duck: 0, now: 2 }); // a holds 0 and is online
  assert.equal(s.players.b.duck, 1);
  s = reduce(s, { type: 'leave', cid: 'a', now: 3 });
  assert.equal(s.players.a.online, false);
  s = reduce(s, { type: 'claim', cid: 'b', duck: 0, now: 4 });
  assert.equal(s.players.b.duck, 0);
  assert.equal(s.players.a.duck, -1);
  assert.equal(freeSlot(s), 1);
  // an offline, unready racer does not block the start; forgetting frees everything
  s = reduce(s, { type: 'ready', cid: 'b', ready: true, now: 5 });
  assert.equal(canStart(s), true);
  s = reduce(s, { type: 'forget', cid: 'a', now: 6 });
  assert.equal(Object.keys(s.players).length, 1);
});

test('host handoff, config validation, race lifecycle, rematch clears ready, best-of wins tally', () => {
  let s = L0();
  for (const cid of ['host', 'p1', 'p2']) s = reduce(s, { type: 'hello', cid, name: cid, now: 1 });
  s = reduce(s, { type: 'config', config: { rule: 'l', items: 0, bestOf: 7 }, now: 2 });
  assert.deepEqual(s.config, { rule: 'l', items: false, bestOf: 1, roster: [] });
  s = reduce(s, { type: 'config', config: { roster: ['Ann', '  Bob ', '', 7] }, now: 2 });
  assert.deepEqual(s.config.roster, ['Ann', 'Bob', '', '7'], 'roster entries are trimmed strings');
  s = reduce(s, { type: 'handoff', to: 'p1', now: 3 });
  assert.equal(s.hostCid, 'p1');
  assert.equal(s.players.p1.role, ROLES.host);
  assert.equal(s.players.host.role, ROLES.player);
  for (const cid of ['host', 'p1', 'p2']) s = reduce(s, { type: 'ready', cid, ready: true, now: 4 });
  s = reduce(s, { type: 'start', startAt: 10_000, now: 5 });
  assert.equal(s.phase, 'countdown');
  assert.equal(s.raceNo, 1);
  assert.equal(canStart(s), false);
  s = reduce(s, { type: 'racing', now: 6 });
  s = reduce(s, { type: 'over', order: ['p2', 'host', 'p1'], times: { p2: 40.1, host: 41, p1: 42 }, now: 7 });
  assert.equal(s.phase, 'results');
  assert.equal(s.wins.p2, 1);
  assert.deepEqual(pickOrder(s.results.order, s.config.rule), ['p1', 'host', 'p2'], 'last place picks first');
  s = reduce(s, { type: 'rematch', now: 8 });
  assert.equal(s.phase, 'lobby');
  assert.equal(s.players.p2.ready, false);
  assert.equal(s.players.p1.ready, true, 'host keeps ready');
});

test('roster echo makes a client converge on the host view', () => {
  let host = L0();
  for (const cid of ['host', 'p1']) host = reduce(host, { type: 'hello', cid, name: cid, now: 1 });
  host = reduce(host, { type: 'ready', cid: 'p1', ready: true, now: 2 });
  let client = initialLobby({ code: 'ACDE', hostCid: 'host', meCid: 'p1', now: 0 });
  client = reduce(client, { type: 'hello', cid: 'p1', name: 'p1', now: 1 }); // local optimistic view: thinks it has slot 0
  assert.equal(client.players.p1.duck, 0);
  client = reduce(client, { type: 'roster', ...rosterMessage(host), now: 3 });
  assert.equal(client.players.p1.duck, 1, 'host says slot 1');
  assert.equal(client.players.host.duck, 0);
  assert.equal(client.players.p1.ready, true);
  assert.equal(connQuality(500), 'good');
  assert.equal(connQuality(3000), 'fair');
  assert.equal(connQuality(20000), 'lost');
});

test('best-of-3 series: points accumulate, standings and final flag, then a fresh series', () => {
  let s = L0();
  for (const cid of ['host', 'a', 'b']) s = reduce(s, { type: 'hello', cid, name: cid, now: 1 });
  s = reduce(s, { type: 'config', config: { bestOf: 3 }, now: 2 });
  s = reduce(s, { type: 'over', order: ['a', 'host', 'b'], raceNo: 1, now: 3 }); // a 3, host 2, b 1
  s = reduce(s, { type: 'over', order: ['a', 'host', 'b'], raceNo: 1, now: 3 }); // duplicate ignored
  assert.equal(seriesStandings(s).done, 1);
  s = reduce(s, { type: 'rematch', now: 4 });
  s = reduce(s, { type: 'over', order: ['b', 'host', 'a'], raceNo: 2, now: 5 }); // b 3+1=4, host 4, a 4
  let st = seriesStandings(s);
  assert.equal(st.final, false);
  assert.deepEqual(st.rows.map((r) => [r.cid, r.points]), [['b', 4], ['host', 4], ['a', 4]], 'tie broken by the latest race');
  s = reduce(s, { type: 'rematch', now: 6 });
  s = reduce(s, { type: 'over', order: ['host', 'a', 'b'], raceNo: 3, now: 7 }); // host 7, a 6, b 5
  st = seriesStandings(s);
  assert.equal(st.final, true);
  assert.deepEqual(st.rows.map((r) => r.cid), ['host', 'a', 'b']);
  // next race starts a new series automatically
  s = reduce(s, { type: 'rematch', now: 8 });
  s = reduce(s, { type: 'over', order: ['b', 'a', 'host'], raceNo: 4, now: 9 });
  assert.equal(seriesStandings(s).done, 1);
  assert.equal(seriesStandings(s).rows[0].cid, 'b');
});

test('line-up: every league seat races (claimed -> that player, unclaimed -> autopilot under the league name), then other claimers', () => {
  let s = L0();
  // host alone with a league roster can start an all-autopilot race
  s = reduce(s, { type: 'hello', cid: 'host', name: 'Big screen', now: 1 });
  s = reduce(s, { type: 'spectate', cid: 'host', now: 1 }); // the laptop only shows the race
  assert.equal(canStart(s), false, 'no roster, no racers');
  s = reduce(s, { type: 'config', config: { roster: ['Evan', 'Nathaniel', 'Connor', 'Ann'] }, now: 2 });
  assert.equal(canStart(s), true, 'roster seats alone make a race');
  assert.deepEqual(lineup(s), [
    { cid: seatCid(0), name: 'Evan' }, { cid: seatCid(1), name: 'Nathaniel' }, { cid: seatCid(2), name: 'Connor' }, { cid: seatCid(3), name: 'Ann' },
  ]);
  assert.equal(nameOf(s, 'seat:2'), 'Connor');
  assert.equal(nameOf(s, 'seat:9'), '—');
  assert.equal(isSeatCid('seat:3'), true);
  assert.equal(isSeatCid('c-abc123'), false);
  // a league member who just opens the link with their saved name lands on their own seat (no tap needed)
  s = reduce(s, { type: 'hello', cid: 'n', name: 'nathaniel', now: 3 });
  assert.equal(s.players.n.duck, 1);
  // a walk-in (name not in the league) gets a duck outside the league seats, then squats on Evan's seat explicitly
  s = reduce(s, { type: 'hello', cid: 'w', name: 'Walk-in', now: 4 });
  assert.equal(s.players.w.duck, 4, 'walk-ins do not take league seats by default');
  s = reduce(s, { type: 'claim', cid: 'w', duck: 0, now: 4 });
  // Ann pre-registered on another device days ago as duck 6 (before the roster existed): her old want is honoured,
  // there is no autopilot double for her, and her seat 3 stays empty (no duck at all, not an AI Ann)
  s = reduce(s, { type: 'hello', cid: 'a', name: 'Ann', want: 6, now: 5 });
  assert.equal(s.players.a.duck, 6);
  assert.deepEqual(lineup(s), [
    { cid: 'w', name: 'Walk-in' }, // seat 0's holder
    { cid: 'n', name: 'nathaniel' },
    { cid: seatCid(2), name: 'Connor' }, // nobody came: autopilot
    { cid: 'a', name: 'Ann' }, // other claimers after the seats
    { cid: seatCid(0), name: 'Evan' }, // displaced by the squatter but still racing
  ]);
  // readiness gates the start for humans who are online; an offline claimer keeps the seat (autopilot until back)
  assert.equal(canStart(s), false);
  for (const cid of ['n', 'a']) s = reduce(s, { type: 'ready', cid, ready: true, now: 6 });
  s = reduce(s, { type: 'leave', cid: 'w', now: 6 });
  assert.equal(canStart(s), true);
  assert.equal(lineup(s)[0].cid, 'w');
  // ...until the seat's owner arrives: Evan takes his seat back from the offline squatter
  s = reduce(s, { type: 'hello', cid: 'e', name: 'Evan', now: 7 });
  assert.equal(s.players.e.duck, 0);
  assert.equal(s.players.w.duck, -1);
  assert.deepEqual(lineup(s).map((x) => x.name), ['Evan', 'nathaniel', 'Connor', 'Ann']);
  // results keyed by seat cids resolve to league names and count for the series
  s = reduce(s, { type: 'ready', cid: 'e', ready: true, now: 8 });
  s = reduce(s, { type: 'start', startAt: 10, now: 9 });
  s = reduce(s, { type: 'over', order: [seatCid(2), 'n', 'a', 'e'], times: {}, now: 10 });
  assert.equal(s.wins[seatCid(2)], 1);
  assert.equal(nameOf(s, seriesStandings(s).rows[0].cid), 'Connor');
});
