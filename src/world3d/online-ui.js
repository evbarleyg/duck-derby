// DOM for the Grand Prix Online lobby panel (world.html #online). Pure view: renders a lobby state and calls
// back into the session for actions. main.js owns phase changes and the 3D side.
import { TOWELS } from '../ducks.js';
import { canStart, racers, connQuality, ROLES, MAX_PLAYERS, seriesStandings } from './net/lobby.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createLobbyUi({ session, shareUrl, onLeave, event = null, onClaim = () => {} }) {
  const el = {
    panel: $('#online'), code: $('#ol-code'), status: $('#ol-status'), qr: $('#ol-qr'), copy: $('#ol-copy'), leave: $('#ol-leave'),
    name: $('#ol-name'), ducks: $('#ol-ducks'), ready: $('#ol-ready'), spectate: $('#ol-spectate'), roster: $('#ol-roster'), count: $('#ol-count'),
    league: $('#ol-league'), leagueNames: $('#ol-league-names'),
    hostbox: $('#ol-hostbox'), guestbox: $('#ol-guestbox'), rule: $('#ol-rule'), items: $('#ol-items'), bestOf: $('#ol-bestof'), go: $('#ol-go'), goSub: $('#ol-go-sub'), fallback: $('#ol-fallback'), duckHint: $('#ol-duck-hint'), series: $('#ol-series'), seriesH: $('#ol-series-h'), seriesList: $('#ol-series-list'),
  };
  el.code.textContent = session.code;
  // QR + link
  const url = shareUrl(session.code);
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    el.qr.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
  } catch { el.qr.textContent = session.code; }
  el.copy.onclick = async () => { try { await navigator.clipboard.writeText(url); el.copy.textContent = 'Copied!'; setTimeout(() => (el.copy.textContent = 'Copy link'), 1200); } catch { prompt('Copy this link', url); } };
  el.leave.onclick = () => onLeave();
  el.name.onchange = () => session.setName(el.name.value.trim());
  el.ready.onclick = () => { const me = session.lobby.players[session.cid]; session.setReady(!(me && me.ready)); };
  el.spectate.onclick = () => session.spectate();
  el.go.onclick = () => {
    const force = !!(event && Date.now() >= Date.parse(event.startsAt)); // official start time reached: unready racers ride on autopilot
    if (!session.startRace({ force })) setStatus('Cannot start yet — someone is not ready', 'error');
  };
  // official event strip in the lobby header
  const evEl = { box: $('#ol-event'), title: $('#ol-event-title'), count: $('#ol-event-count'), when: $('#ol-event-when') };
  if (event && evEl.box) {
    evEl.box.hidden = false;
    evEl.title.textContent = event.title;
    const at = Date.parse(event.startsAt);
    evEl.when.textContent = new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const tick = () => { const left = at - Date.now(); if (left <= 0) { evEl.count.textContent = 'now'; return; } let s = Math.floor(left / 1000); const d = Math.floor(s / 86400); s -= d * 86400; const h = Math.floor(s / 3600); s -= h * 3600; const mi = Math.floor(s / 60); s -= mi * 60; evEl.count.textContent = (d ? d + 'd ' : '') + String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0') + ':' + String(s).padStart(2, '0'); };
    tick();
    setInterval(tick, 1000);
  } else if (evEl.box) evEl.box.hidden = true;
  el.fallback.onclick = () => { if (confirm('Let the ducks decide? Nobody drives: the seeded race plays identically on every phone.')) session.fallback(); };
  el.rule.onchange = () => session.setConfig({ rule: el.rule.value });
  el.items.onchange = () => session.setConfig({ items: el.items.checked });
  el.bestOf.onchange = () => session.setConfig({ bestOf: Number(el.bestOf.value) });
  // duck slot buttons (identity = number + towel colour; palette/hat are dealt at the start from the names)
  el.ducks.innerHTML = '';
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    const tw = TOWELS[i % TOWELS.length];
    b.style.background = tw.bg;
    b.style.color = tw.text;
    b.textContent = String(i + 1);
    b.title = `Duck ${i + 1} (${tw.name || ''})`;
    b.onclick = () => { if (!b.classList.contains('taken')) { session.claim(i); onClaim(i); } };
    el.ducks.appendChild(b);
  }
  let lastKey = '';

  function setStatus(text, level = 'info') {
    el.status.textContent = text;
    el.status.className = 'ol-status ' + (level === 'ok' ? 'ok' : level === 'error' ? 'error' : '');
  }

  let leagueKey = '';
  function renderLeague(lobby, me) {
    const roster = (lobby.config.roster || []).filter(Boolean);
    el.league.hidden = roster.length === 0;
    if (!roster.length) return;
    const takenBy = new Map(); // lower-cased name -> player (online, not me)
    for (const p of Object.values(lobby.players)) if (p.online && p.cid !== session.cid) takenBy.set(String(p.name).toLowerCase(), p);
    const key = JSON.stringify([roster, [...takenBy.keys()], me && me.name, me && me.duck]);
    if (key === leagueKey) return;
    leagueKey = key;
    el.leagueNames.innerHTML = '';
    roster.forEach((nm, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      const mine = me && String(me.name).toLowerCase() === nm.toLowerCase();
      const taken = takenBy.has(nm.toLowerCase());
      const tw = TOWELS[i % TOWELS.length];
      b.className = mine ? 'me' : taken ? 'taken' : '';
      b.innerHTML = `<i style="background:${tw.bg}"></i>${esc(nm)}`;
      b.title = taken ? `${nm} is already here` : `I'm ${nm} (duck ${i + 1})`;
      b.onclick = () => {
        if (taken) return;
        el.name.value = nm;
        session.setName(nm);
        el.name.dispatchEvent(new Event('change')); // persists the name on this device (main.js listens)
        // the league seat doubles as the duck: name #i -> duck i (if someone offline/nobody holds it)
        const holder = Object.values(lobby.players).find((p) => p.duck === i && p.online && p.cid !== session.cid);
        if (!holder) { session.claim(i); onClaim(i); }
      };
      el.leagueNames.appendChild(b);
    });
  }

  function render(lobby) {
    const me = lobby.players[session.cid];
    const isHost = lobby.hostCid === session.cid;
    renderLeague(lobby, me);
    if (me && document.activeElement !== el.name && el.name.value !== me.name) el.name.value = me.name;
    // slots
    const taken = new Map();
    for (const p of Object.values(lobby.players)) if (p.duck >= 0 && p.online) taken.set(p.duck, p);
    [...el.ducks.children].forEach((b, i) => {
      const holder = taken.get(i);
      b.classList.toggle('mine', !!me && me.duck === i);
      b.classList.toggle('taken', !!holder && holder.cid !== session.cid);
      const seatName = (lobby.config.roster || [])[i];
      b.innerHTML = `${i + 1}${holder && holder.cid !== session.cid ? `<span class="hat">${esc(holder.name)}</span>` : seatName && !(me && me.duck === i) ? `<span class="hat" style="opacity:.55">${esc(seatName)}</span>` : ''}`;
    });
    el.duckHint.textContent = me && me.duck >= 0 ? `you are duck ${me.duck + 1}` : me && me.role === ROLES.spectator ? 'watching only' : 'tap a free one';
    // ready button
    el.ready.classList.toggle('on', !!(me && me.ready));
    el.ready.textContent = me && me.ready ? 'Ready ✓ (tap to un-ready)' : 'Ready';
    el.ready.hidden = !!(me && me.role === ROLES.spectator && !isHost);
    el.spectate.hidden = !!(me && me.role === ROLES.spectator);
    // roster
    const now = Date.now();
    const rows = Object.values(lobby.players).sort((a, b) => (a.duck < 0) - (b.duck < 0) || a.duck - b.duck || a.joinedAt - b.joinedAt);
    const key = JSON.stringify(rows.map((p) => [p.cid, p.name, p.duck, p.ready, p.role, p.online, connQuality(now - p.lastSeen), isHost && session.rtc ? session.rtc.isOpen(p.cid) : session.rtcLinked])) + '|' + lobby.hostCid + isHost + lobby.phase;
    if (key !== lastKey) {
      lastKey = key;
      el.roster.innerHTML = rows.map((p) => {
        const tw = p.duck >= 0 ? TOWELS[p.duck % TOWELS.length] : { bg: '#445', text: '#fff' };
        const q = p.cid === session.cid ? 'good' : p.online ? connQuality(now - p.lastSeen) : 'lost';
        const linked = isHost ? session.rtc && session.rtc.isOpen(p.cid) : p.cid === lobby.hostCid && session.rtcLinked;
        const tags = (p.cid === lobby.hostCid ? '<small>HOST</small>' : '') + (p.role === ROLES.spectator ? '<small>TV</small>' : '') + (p.cid === session.cid ? '<small>YOU</small>' : '') + (linked ? '<small title="direct peer-to-peer link (no relay quota)">P2P</small>' : '');
        const hostBtns = isHost && p.cid !== session.cid ? `<span>${p.online && p.role !== ROLES.spectator ? `<button class="rowbtn" data-act="host" data-cid="${esc(p.cid)}" title="Make this player the host">host</button>` : ''}${!p.online ? `<button class="rowbtn" data-act="kick" data-cid="${esc(p.cid)}" title="Remove (offline)">remove</button>` : ''}</span>` : '<span></span>';
        return `<li class="${p.cid === session.cid ? 'me' : ''} ${p.online ? '' : 'offline'}"><span class="slot">${p.duck >= 0 ? p.duck + 1 : '–'}</span><span class="sw" style="background:${tw.bg};color:${tw.text}">${p.duck >= 0 ? p.duck + 1 : 'TV'}</span><span class="nm">${esc(p.name || 'Duck')}${tags}</span><span class="rdy ${p.ready ? 'on' : ''}">${p.role === ROLES.spectator ? 'watching' : p.ready ? 'READY' : p.online ? 'not ready' : 'offline'}</span><span class="dot ${q}" title="${q}"></span>${hostBtns}</li>`;
      }).join('');
      for (const b of el.roster.querySelectorAll('.rowbtn')) b.onclick = () => { if (b.dataset.act === 'host') session.handoff(b.dataset.cid); else session.kick(b.dataset.cid); };
    }
    el.count.textContent = String(racers(lobby).length);
    // series standings (best-of-N)
    const st = seriesStandings(lobby);
    const showSeries = lobby.config.bestOf > 1 && st.done > 0;
    el.series.hidden = !showSeries;
    if (showSeries) {
      el.seriesH.textContent = st.final ? `Series decided after ${st.done} races — final standings` : `Series standings after race ${st.done} of ${st.of}`;
      el.seriesList.innerHTML = st.rows.map((r, k) => `<li><span>${k + 1}</span><span>${esc(lobby.players[r.cid] ? lobby.players[r.cid].name : '—')}</span><b>${r.points} pt${r.points === 1 ? '' : 's'}</b></li>`).join('');
    }
    // host controls
    el.hostbox.hidden = !isHost;
    el.guestbox.hidden = isHost;
    if (isHost) {
      if (document.activeElement !== el.rule) el.rule.value = lobby.config.rule;
      if (document.activeElement !== el.bestOf) el.bestOf.value = String(lobby.config.bestOf);
      el.items.checked = !!lobby.config.items;
      const ok = canStart(lobby);
      el.go.disabled = !ok;
      const rs = racers(lobby);
      const notReady = rs.filter((p) => p.online && !p.ready).map((p) => p.name);
      const raceLabel = lobby.config.bestOf > 1 ? ` · race ${Math.min(st.final ? 1 : st.done + 1, lobby.config.bestOf)} of ${lobby.config.bestOf}` : '';
      el.go.textContent = lobby.config.bestOf > 1 ? `Start race ${st.final ? 1 : st.done + 1} of ${lobby.config.bestOf}` : 'Start the Grand Prix';
      el.goSub.textContent = (ok ? `${rs.length} racer${rs.length === 1 ? '' : 's'} ready — go when you are` : rs.length === 0 ? 'Nobody has claimed a duck yet' : `Waiting for: ${notReady.join(', ')}`) + raceLabel;
      if (event) {
        const left = Date.parse(event.startsAt) - Date.now();
        if (left > 15 * 60 * 1000) { el.go.disabled = true; el.go.textContent = 'Opens 15 min before the start'; el.goSub.textContent = `${rs.length} registered so far · people can claim their duck now and come back at race time`; }
        else if (left <= 0 && !ok && rs.length >= 1) { el.go.disabled = false; el.go.textContent = `Start now (${notReady.length} not ready → autopilot)`; }
      }
    } else {
      const host = lobby.players[lobby.hostCid];
      el.guestbox.textContent = lobby.hostCid ? `${host ? host.name : 'The host'} starts the race when everyone is ready · ${lobby.config.rule === 'l' ? 'last place picks first' : 'winner picks first'}${lobby.config.bestOf > 1 ? ` · series of ${lobby.config.bestOf} (points)` : ''}` : event ? 'You are registered on this phone: your name and duck are saved. Come back to this link at race time — the host opens the room shortly before the start.' : 'Looking for the host…';
    }
  }

  return { el, render, setStatus, show(v) { el.panel.hidden = !v; } };
}
