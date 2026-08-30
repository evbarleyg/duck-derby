// Lobby state machine as a pure reducer (no DOM, no network): the host runs it authoritatively and
// broadcasts the converged roster; clients run the same reducer on the messages they see so their UI
// is responsive before the host's roster echo arrives. Unit-tested in test/world3d.net.lobby.test.js.

export const MAX_PLAYERS = 16;
export const ROLES = { host: 'host', player: 'player', spectator: 'spectator' };

export function initialLobby({ code, hostCid, meCid, now = 0 }) {
  return {
    code,
    hostCid,
    meCid,
    phase: 'lobby', // lobby | countdown | race | results
    config: { rule: 'w', items: true, bestOf: 1 },
    players: {}, // cid -> { cid, name, duck (slot index or -1), ready, role, lastSeen, online, joinedAt }
    raceNo: 0,
    startAt: null,
    results: null, // { order:[cid...], times:{cid:sec}, raceNo }
    wins: {}, // cid -> wins
    series: { points: {}, done: 0 }, // best-of-N: cumulative points (n for 1st … 1 for last), races completed
    updatedAt: now,
  };
}

function withPlayer(state, cid, patch, now) {
  const prev = state.players[cid] || { cid, name: '', duck: -1, ready: false, role: ROLES.player, lastSeen: now, online: true, joinedAt: now };
  return { ...state, players: { ...state.players, [cid]: { ...prev, ...patch } }, updatedAt: now };
}

/** All duck slots currently claimed (slot -> cid). */
export function claimedSlots(state) {
  const m = new Map();
  for (const p of Object.values(state.players)) if (p.duck >= 0 && p.role !== ROLES.spectator) m.set(p.duck, p.cid);
  return m;
}

/** Lowest free duck slot, or -1. */
export function freeSlot(state, max = MAX_PLAYERS) {
  const used = claimedSlots(state);
  for (let i = 0; i < max; i++) if (!used.has(i)) return i;
  return -1;
}

/** Players that will race (claimed a duck, not spectators), in slot order. */
export function racers(state) {
  return Object.values(state.players).filter((p) => p.duck >= 0 && p.role !== ROLES.spectator).sort((a, b) => a.duck - b.duck);
}

/** GO is allowed when ≥ 1 racer (2 for a real race, but solo is useful for testing), everyone online is ready, and we're in the lobby. */
export function canStart(state) {
  if (state.phase !== 'lobby') return false;
  const rs = racers(state);
  if (rs.length < 1) return false;
  return rs.every((p) => p.ready || !p.online);
}

/**
 * reduce(state, action) -> new state. Actions:
 *  {type:'hello', cid, name, role?, now}        someone announced themselves (join / rename / reconnect)
 *  {type:'leave', cid, now}                      presence left (marks offline; the slot is kept for reconnects)
 *  {type:'forget', cid, now}                     host drops an offline player entirely (frees the slot)
 *  {type:'claim', cid, duck, now}                claim a duck slot (ignored if taken by someone else online)
 *  {type:'ready', cid, ready, now}
 *  {type:'config', config, now}                  host changed rule/items/bestOf
 *  {type:'handoff', to, now}                     host-ship moves to another cid
 *  {type:'roster', players, hostCid, config, phase, raceNo, now}   authoritative echo from the host (clients adopt it)
 *  {type:'start', startAt, raceNo, now}
 *  {type:'racing', now}
 *  {type:'over', order, times, raceNo, now}
 *  {type:'rematch', now}                         back to lobby, ready flags cleared
 *  {type:'seen', cid, now}                       any traffic from cid (connection freshness)
 */
export function reduce(state, a) {
  const now = a.now ?? state.updatedAt;
  switch (a.type) {
    case 'hello': {
      const existing = state.players[a.cid];
      const role = a.cid === state.hostCid ? ROLES.host : a.role || (existing ? existing.role : ROLES.player);
      const name = String(a.name || '').slice(0, 22) || (existing && existing.name) || 'Duck';
      let next = withPlayer(state, a.cid, { name, role, online: true, lastSeen: now }, now);
      const p = next.players[a.cid];
      // pre-registered preference ("I claimed duck 7 on this phone yesterday"): honour it if the slot is free or only
      // held by someone offline -- and if that offline holder has the same name it is this person's old session: drop it
      if (p.duck < 0 && role !== ROLES.spectator && Number.isInteger(a.want) && a.want >= 0 && a.want < MAX_PLAYERS) {
        const holder = claimedSlots(next).get(a.want);
        const h = holder ? next.players[holder] : null;
        if (!h || (!h.online && holder !== a.cid)) {
          if (h) {
            const players = { ...next.players };
            if (h.name === name) delete players[holder];
            else players[holder] = { ...h, duck: -1 };
            next = { ...next, players };
          }
          next = withPlayer(next, a.cid, { duck: a.want }, now);
        }
      }
      // otherwise auto-claim the lowest free slot for new non-spectators
      if (next.players[a.cid].duck < 0 && role !== ROLES.spectator) {
        const slot = freeSlot(next);
        if (slot >= 0) next = withPlayer(next, a.cid, { duck: slot }, now);
      }
      return next;
    }
    case 'leave': {
      if (!state.players[a.cid]) return state;
      return withPlayer(state, a.cid, { online: false, ready: false, lastSeen: now }, now);
    }
    case 'forget': {
      if (!state.players[a.cid]) return state;
      const players = { ...state.players };
      delete players[a.cid];
      return { ...state, players, updatedAt: now };
    }
    case 'claim': {
      const taken = claimedSlots(state).get(a.duck);
      if (taken && taken !== a.cid && state.players[taken] && state.players[taken].online) return state; // someone online has it
      let next = state;
      if (taken && taken !== a.cid) next = withPlayer(next, taken, { duck: -1 }, now); // offline holder loses it
      return withPlayer(next, a.cid, { duck: a.duck, role: state.players[a.cid] && state.players[a.cid].role === ROLES.host ? ROLES.host : ROLES.player }, now);
    }
    case 'spectate': {
      if (!state.players[a.cid]) return state;
      return withPlayer(state, a.cid, { duck: -1, ready: true, role: a.cid === state.hostCid ? ROLES.host : ROLES.spectator }, now);
    }
    case 'ready': {
      if (!state.players[a.cid]) return state;
      return withPlayer(state, a.cid, { ready: !!a.ready, lastSeen: now }, now);
    }
    case 'config': {
      const c = { ...state.config, ...a.config };
      c.rule = c.rule === 'l' ? 'l' : 'w';
      c.items = !!c.items;
      c.bestOf = [1, 3, 5].includes(c.bestOf) ? c.bestOf : 1;
      return { ...state, config: c, updatedAt: now };
    }
    case 'handoff': {
      if (!state.players[a.to]) return state;
      const players = { ...state.players };
      for (const cid of Object.keys(players)) {
        const p = players[cid];
        if (cid === a.to) players[cid] = { ...p, role: ROLES.host };
        else if (p.role === ROLES.host) players[cid] = { ...p, role: p.duck >= 0 ? ROLES.player : ROLES.spectator };
      }
      return { ...state, hostCid: a.to, players, updatedAt: now };
    }
    case 'roster': {
      // adopt the host's view wholesale, but keep our own freshness stamps
      const players = {};
      for (const p of a.players || []) players[p.cid] = { ...(state.players[p.cid] || {}), ...p, lastSeen: (state.players[p.cid] && state.players[p.cid].lastSeen) || now };
      return { ...state, players, hostCid: a.hostCid ?? state.hostCid, config: a.config ? { ...state.config, ...a.config } : state.config, phase: a.phase || state.phase, raceNo: a.raceNo ?? state.raceNo, series: a.series || state.series, updatedAt: now };
    }
    case 'start':
      return { ...state, phase: 'countdown', startAt: a.startAt, raceNo: a.raceNo ?? state.raceNo + 1, results: null, updatedAt: now };
    case 'racing':
      return { ...state, phase: 'race', updatedAt: now };
    case 'over': {
      if (state.results && state.results.raceNo === (a.raceNo ?? state.raceNo) && state.phase === 'results') return state; // duplicate delivery
      const wins = { ...state.wins };
      if (a.order && a.order.length) wins[a.order[0]] = (wins[a.order[0]] || 0) + 1;
      // series points: a new series starts when the previous one completed
      const prev = state.series && state.series.done < state.config.bestOf ? state.series : { points: {}, done: 0 };
      const points = { ...prev.points };
      const n = a.order ? a.order.length : 0;
      (a.order || []).forEach((cid, k) => { points[cid] = (points[cid] || 0) + (n - k); });
      const series = { points, done: prev.done + 1, lastOrder: a.order || [] };
      return { ...state, phase: 'results', results: { order: a.order, times: a.times || {}, raceNo: a.raceNo ?? state.raceNo }, wins, series, updatedAt: now };
    }
    case 'newSeries':
      return { ...state, series: { points: {}, done: 0 }, updatedAt: now };
    case 'rematch': {
      const players = {};
      for (const [cid, p] of Object.entries(state.players)) players[cid] = { ...p, ready: p.role === ROLES.host ? p.ready : false };
      return { ...state, phase: 'lobby', startAt: null, results: null, players, updatedAt: now };
    }
    case 'seen': {
      if (!state.players[a.cid]) return state;
      return withPlayer(state, a.cid, { lastSeen: now, online: true }, now);
    }
    default:
      return state;
  }
}

/** The roster message the host broadcasts (also what clients adopt). */
export function rosterMessage(state) {
  return {
    players: Object.values(state.players).map((p) => ({ cid: p.cid, name: p.name, duck: p.duck, ready: p.ready, role: p.role, online: p.online })),
    hostCid: state.hostCid,
    config: state.config,
    phase: state.phase,
    raceNo: state.raceNo,
    series: state.series,
  };
}

/**
 * Draft order from a finish order under the rule ('w' winner picks first | 'l' last place picks first).
 * order: array of cids (finish order). Returns array of cids in pick order.
 */
export function pickOrder(order, rule) {
  return rule === 'l' ? order.slice().reverse() : order.slice();
}

/**
 * Series standings: [{cid, points}] best first; ties broken by the better finish in the latest race.
 * `final` is true when the configured number of races has been run.
 */
export function seriesStandings(state) {
  const s = state.series || { points: {}, done: 0, lastOrder: [] };
  const last = s.lastOrder || [];
  const rows = Object.entries(s.points).map(([cid, points]) => ({ cid, points, last: last.indexOf(cid) < 0 ? 999 : last.indexOf(cid) }));
  rows.sort((a, b) => b.points - a.points || a.last - b.last);
  return { rows, done: s.done, of: state.config.bestOf, final: s.done >= state.config.bestOf };
}

/** Connection quality from last-seen age (ms): 'good' | 'fair' | 'poor' | 'lost'. */
export function connQuality(ageMs) {
  if (ageMs < 1500) return 'good';
  if (ageMs < 4000) return 'fair';
  if (ageMs < 10000) return 'poor';
  return 'lost';
}
