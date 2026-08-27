// Supabase project for the online lobby + race transport (Realtime only:
// broadcast + presence; no database tables, no auth, no RLS).
//
// The publishable key is public-by-design (it ships to every browser); access
// control is not a goal here — random room codes are the only gate, which is
// fine for a duck race. The service_role / secret keys are NOT in this repo
// and must never be committed. If the key is ever abused, Evan rotates it in
// the Supabase dashboard (project ref below) and updates this file.
//
// Verified live 2026-08-27: /auth/v1/health -> 200, Realtime websocket
// handshake -> 101 with this key. Note: GET /rest/v1/ (the OpenAPI root)
// returns 401 "only service_role" on this project — that endpoint is
// restricted on new Supabase projects and is NOT a sign the key is bad.
export const NET_CONFIG = {
  supabaseUrl: 'https://aqguvjeqwjvuyfchldwq.supabase.co',
  supabaseKey: 'sb_publishable_z-kYVmA3tBjtcob-K1joig_zGl-dF6J',
  projectRef: 'aqguvjeqwjvuyfchldwq',
  // WebRTC race path (host <-> phones data channels). STUN is enough for most home wifi / carriers; phones behind a
  // symmetric NAT need TURN. To add one, append e.g.
  //   { urls: ['turn:global.relay.metered.ca:80', 'turns:global.relay.metered.ca:443?transport=tcp'], username: '…', credential: '…' }
  // (free tiers: Metered/OpenRelay, Cloudflare Calls TURN, or ExpressTURN). Credentials here are public-by-design
  // like the Supabase key; use a provider's short-lived-credential API if that matters. Without TURN, an unlinked
  // phone automatically stays on the Supabase broadcast path (counted against the 100 events/s quota).
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
};
