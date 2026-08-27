// Room codes: 4 letters from an unambiguous alphabet (no 0/O, 1/I/L, 5/S, 2/Z, 8/B, U/V).
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTWXY';
export const CODE_LENGTH = 4;

/** Random room code. `rnd` is Math.random-compatible (injectable for tests). */
export function makeRoomCode(rnd = Math.random) {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(rnd() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return s;
}

/** Normalise user input ("k7 mq" -> "K7MQ"-ish): uppercase, strip spaces/dashes, map look-alikes, validate. Returns null if invalid. */
export function normalizeRoomCode(input) {
  if (typeof input !== 'string') return null;
  const map = { 0: 'O', 1: 'I', 5: 'S', 2: 'Z', 8: 'B' }; // typed digits -> the letter they resemble (then rejected if not in alphabet)
  let s = input.toUpperCase().replace(/[\s\-_.]/g, '');
  s = s.replace(/[01528]/g, (d) => map[d]);
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** Stable per-device client id (persisted by the caller). */
export function makeClientId(rnd = Math.random) {
  let s = '';
  for (let i = 0; i < 10; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rnd() * 36) % 36];
  return s;
}
