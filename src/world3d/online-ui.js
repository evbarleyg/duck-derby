// DOM for the Grand Prix Online lobby panel (world.html #online). Pure view: renders a lobby state and calls
// back into the session for actions. main.js owns phase changes and the 3D side.
import { TOWELS } from '../ducks.js';
import { canStart, racers, connQuality, ROLES, MAX_PLAYERS } from './net/lobby.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createLobbyUi({ session, shareUrl, onLeave }) {
  const el = {
    panel: $('#online'), code: $('#ol-code'), status: $('#ol-status'), qr: $('#ol-qr'), copy: $('#ol-copy'), leave: $('#ol-leave'),
    name: $('#ol-name'), ducks: $('#ol-ducks'), ready: $('#ol-ready'), spectate: $('#ol-spectate'), roster: $('#ol-roster'), count: $('#ol-count'),
    hostbox: $('#ol-hostbox'), guestbox: $('#ol-guestbox'), rule: $('#ol-rule'), items: $('#ol-items'), go: $('#ol-go'), goSub: $('#ol-go-sub'), fallback: $('#ol-fallback'), duckHint: $('#ol-duck-hint'),
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
  el.go.onclick = () => { if (!session.startRace()) setStatus('Cannot start yet — someone is not ready', 'error'); };
  el.fallback.onclick = () => { if (confirm('Let the ducks decide? Nobody drives: the seeded race plays identically on every phone.')) session.fallback(); };
  el.rule.onchange = () => session.setConfig({ rule: el.rule.value });
  el.items.onchange = () => session.setConfig({ items: el.items.checked });
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
    b.onclick = () => { if (!b.classList.contains('taken')) session.claim(i); };
    el.ducks.appendChild(b);
  }
  let lastKey = '';

  function setStatus(text, level = 'info') {
    el.status.textContent = text;
    el.status.className = 'ol-status ' + (level === 'ok' ? 'ok' : level === 'error' ? 'error' : '');
  }

  function render(lobby) {
    const me = lobby.players[session.cid];
    const isHost = lobby.hostCid === session.cid;
    if (me && document.activeElement !== el.name && el.name.value !== me.name) el.name.value = me.name;
    // slots
    const taken = new Map();
    for (const p of Object.values(lobby.players)) if (p.duck >= 0 && p.online) taken.set(p.duck, p);
    [...el.ducks.children].forEach((b, i) => {
      const holder = taken.get(i);
      b.classList.toggle('mine', !!me && me.duck === i);
      b.classList.toggle('taken', !!holder && holder.cid !== session.cid);
      b.innerHTML = `${i + 1}${holder && holder.cid !== session.cid ? `<span class="hat">${esc(holder.name)}</span>` : ''}`;
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
    const key = JSON.stringify(rows.map((p) => [p.cid, p.name, p.duck, p.ready, p.role, p.online, connQuality(now - p.lastSeen)])) + '|' + lobby.hostCid + isHost + lobby.phase;
    if (key !== lastKey) {
      lastKey = key;
      el.roster.innerHTML = rows.map((p) => {
        const tw = p.duck >= 0 ? TOWELS[p.duck % TOWELS.length] : { bg: '#445', text: '#fff' };
        const q = p.cid === session.cid ? 'good' : p.online ? connQuality(now - p.lastSeen) : 'lost';
        const tags = (p.cid === lobby.hostCid ? '<small>HOST</small>' : '') + (p.role === ROLES.spectator ? '<small>TV</small>' : '') + (p.cid === session.cid ? '<small>YOU</small>' : '');
        const hostBtns = isHost && p.cid !== session.cid ? `<span>${p.online && p.role !== ROLES.spectator ? `<button class="rowbtn" data-act="host" data-cid="${esc(p.cid)}" title="Make this player the host">host</button>` : ''}${!p.online ? `<button class="rowbtn" data-act="kick" data-cid="${esc(p.cid)}" title="Remove (offline)">remove</button>` : ''}</span>` : '<span></span>';
        return `<li class="${p.cid === session.cid ? 'me' : ''} ${p.online ? '' : 'offline'}"><span class="slot">${p.duck >= 0 ? p.duck + 1 : '–'}</span><span class="sw" style="background:${tw.bg};color:${tw.text}">${p.duck >= 0 ? p.duck + 1 : 'TV'}</span><span class="nm">${esc(p.name || 'Duck')}${tags}</span><span class="rdy ${p.ready ? 'on' : ''}">${p.role === ROLES.spectator ? 'watching' : p.ready ? 'READY' : p.online ? 'not ready' : 'offline'}</span><span class="dot ${q}" title="${q}"></span>${hostBtns}</li>`;
      }).join('');
      for (const b of el.roster.querySelectorAll('.rowbtn')) b.onclick = () => { if (b.dataset.act === 'host') session.handoff(b.dataset.cid); else session.kick(b.dataset.cid); };
    }
    el.count.textContent = String(racers(lobby).length);
    // host controls
    el.hostbox.hidden = !isHost;
    el.guestbox.hidden = isHost;
    if (isHost) {
      if (document.activeElement !== el.rule) el.rule.value = lobby.config.rule;
      el.items.checked = !!lobby.config.items;
      const ok = canStart(lobby);
      el.go.disabled = !ok;
      const rs = racers(lobby);
      const notReady = rs.filter((p) => p.online && !p.ready).map((p) => p.name);
      el.goSub.textContent = ok ? `${rs.length} racer${rs.length === 1 ? '' : 's'} ready — go when you are` : rs.length === 0 ? 'Nobody has claimed a duck yet' : `Waiting for: ${notReady.join(', ')}`;
    } else {
      const host = lobby.players[lobby.hostCid];
      el.guestbox.textContent = lobby.hostCid ? `${host ? host.name : 'The host'} starts the race when everyone is ready · rule: ${lobby.config.rule === 'l' ? 'last place picks first' : 'winner picks first'}` : 'Looking for the host…';
    }
  }

  return { el, render, setStatus, show(v) { el.panel.hidden = !v; } };
}
