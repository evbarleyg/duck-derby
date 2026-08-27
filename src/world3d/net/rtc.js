// WebRTC star for the race traffic: the host opens a peer connection to every other participant and pushes
// frames (snapshot + events + pongs) down an unordered, no-retransmit data channel; players send their inputs
// back up the same way. Signalling rides the room's control channel; Supabase Realtime then only carries the
// lobby, signalling and whatever peers could not connect (symmetric NAT without TURN) -- those stay on the
// broadcast path automatically. Pure feature: if RTCPeerConnection is missing (Node bots, old browsers) the
// session behaves exactly as before.
import { NET_CONFIG } from './net-config.js';
const ICE = NET_CONFIG.iceServers || [{ urls: ['stun:stun.l.google.com:19302'] }];
export const RTC_SUPPORTED = typeof RTCPeerConnection === 'function';

/**
 * createRtcStar({ cid, isHost: () => bool, hostCid: () => cid, signal: (to, kind, data) => void,
 *                 onFrame(obj), onInput(cid, obj), onChange() })
 * Host side: connectTo(cid) per participant; sendFrame(obj) -> Set of cids reached.
 * Guest side: handles offers from the host; sendInput(obj) -> true if it went over the data channel.
 */
export function createRtcStar({ cid, isHost, hostCid, signal, onFrame, onInput, onChange = () => {} }) {
  const peers = new Map(); // remote cid -> { pc, state, input, open, since }
  const stats = { framesOut: 0, framesIn: 0, inputsOut: 0, inputsIn: 0 };

  function makePc(remote) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const peer = { pc, state: null, input: null, open: false, since: 0, remote };
    peers.set(remote, peer);
    pc.onicecandidate = (e) => { if (e.candidate) signal(remote, 'rtc-ice', { cand: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { peer.open = false; onChange(); }
    };
    return peer;
  }
  function wireChannels(peer) {
    const { state, input } = peer;
    if (state) {
      state.onopen = () => { peer.open = true; peer.since = performance.now(); onChange(); };
      state.onclose = () => { peer.open = false; onChange(); };
      state.onmessage = (e) => { stats.framesIn++; try { onFrame(JSON.parse(e.data)); } catch { /* ignore */ } };
    }
    if (input) {
      input.onmessage = (e) => { stats.inputsIn++; try { onInput(peer.remote, JSON.parse(e.data)); } catch { /* ignore */ } };
    }
  }

  /** Host: open a connection to a participant (idempotent). */
  async function connectTo(remote) {
    if (!RTC_SUPPORTED || remote === cid) return;
    const existing = peers.get(remote);
    if (existing && (existing.open || existing.pc.connectionState === 'connecting' || existing.pc.connectionState === 'new')) return;
    if (existing) close(remote);
    const peer = makePc(remote);
    peer.state = peer.pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
    peer.input = peer.pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
    wireChannels(peer);
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      signal(remote, 'rtc-offer', { sdp: peer.pc.localDescription.sdp, type: peer.pc.localDescription.type });
    } catch (e) { console.warn('[rtc] offer failed', e); close(remote); }
  }

  /** Both sides: feed signalling messages addressed to us. */
  async function onSignal(from, kind, data) {
    if (!RTC_SUPPORTED) return;
    try {
      if (kind === 'rtc-offer') {
        if (from !== hostCid()) return; // only the host may connect to us
        if (peers.has(from)) close(from);
        const peer = makePc(from);
        peer.pc.ondatachannel = (e) => {
          if (e.channel.label === 'state') peer.state = e.channel;
          else if (e.channel.label === 'input') peer.input = e.channel;
          wireChannels(peer);
        };
        await peer.pc.setRemoteDescription(data);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        signal(from, 'rtc-answer', { sdp: peer.pc.localDescription.sdp, type: peer.pc.localDescription.type });
      } else if (kind === 'rtc-answer') {
        const peer = peers.get(from);
        if (peer && isHost()) await peer.pc.setRemoteDescription(data);
      } else if (kind === 'rtc-ice') {
        const peer = peers.get(from);
        if (peer && data.cand) await peer.pc.addIceCandidate(data.cand).catch(() => {});
      }
    } catch (e) { console.warn('[rtc] signalling error', kind, e && e.message); }
  }

  /** Host: push a frame to every open peer; returns the set of cids it reached. */
  function sendFrame(obj) {
    const reached = new Set();
    if (!peers.size) return reached;
    const text = JSON.stringify(obj);
    for (const [remote, peer] of peers) {
      if (peer.open && peer.state && peer.state.readyState === 'open') {
        try { peer.state.send(text); reached.add(remote); stats.framesOut++; } catch { peer.open = false; }
      }
    }
    return reached;
  }
  /** Guest: send an input to the host over the data channel; false if not available (use the relay). */
  function sendInput(obj) {
    const peer = peers.get(hostCid());
    if (!peer || !peer.input || peer.input.readyState !== 'open') return false;
    try { peer.input.send(JSON.stringify(obj)); stats.inputsOut++; return true; } catch { return false; }
  }
  function isOpen(remote) { const p = peers.get(remote); return !!(p && p.open && p.state && p.state.readyState === 'open'); }
  function hostLinkOpen() { return isOpen(hostCid()); }
  function close(remote) { const p = peers.get(remote); if (!p) return; try { p.pc.close(); } catch { /* ignore */ } peers.delete(remote); }
  function closeAll() { for (const r of [...peers.keys()]) close(r); }
  return { supported: RTC_SUPPORTED, connectTo, onSignal, sendFrame, sendInput, isOpen, hostLinkOpen, close, closeAll, stats, peers };
}
