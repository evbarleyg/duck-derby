# Vendored: @supabase/supabase-js

- Package: `@supabase/supabase-js`
- Version: **2.112.4** (fetched with `npm pack @supabase/supabase-js@2` from registry.npmjs.org)
- File: `dist/umd/supabase.js` → `vendor/supabase/supabase.js` (standalone UMD bundle, exposes `window.supabase`)
- License: MIT (see `LICENSE`)
- Used by: `world.html` (loaded with a plain `<script>` before the module graph); `src/world3d/net/supabase-transport.js` calls `window.supabase.createClient(...)`.
- Only the Realtime client is used (broadcast + presence channels). No database, auth or storage calls.

To update: repeat the `npm pack`, replace the file, bump the version here, run `npm run ci` and the net probe.
