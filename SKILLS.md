# SKILLS.md — Courtline how-tos

Repeatable procedures for humans and AI agents. Project context lives in [AGENTS.md](AGENTS.md).

---

## 1. Run locally

```bash
bundle install
SESSION_SECRET="$(ruby -rsecurerandom -e 'puts SecureRandom.hex(48)')" \
BROADCAST_PASSWORD='local-cast' VIEWER_PASSWORD='local-view' \
bundle exec puma -p 9292 config.ru
```

Open http://localhost:9292. Camera access works on `localhost` without HTTPS.
For cloud features locally, also export the four `R2_*` vars and add `http://localhost:9292` to the bucket CORS `AllowedOrigins`.

**Testing without a camera:** in DevTools, replace `openCamera` with a canvas stream:

```js
openCamera = async () => { const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const x = c.getContext('2d'); (function d(){ x.fillStyle = '#2a6'; x.fillRect(0,0,1280,720);
  x.fillStyle = '#fff'; x.fillRect(560,280,160,160); requestAnimationFrame(d); })(); return c.captureStream(30); };
```

## 2. Deploy

1. `ruby -c server.rb` (syntax check).
2. Commit and push to `main` on GitHub (`Mowlavie/tennis-live`). Render auto-deploys in about 1 minute.
3. Check Render → tennis-live → Deploys for "Deploy succeeded | Live".
4. Changing an env var in Render → Environment → **Save, rebuild, and deploy** also redeploys.

## 3. Debug "videos aren't saving to the cloud"

Work through these in order:

1. **Read the status line** in the app after Stop & save, and the **Cloud replays** section. They name the problem:
   - `Missing on server: R2_...` → add those env vars in Render.
   - `Could not reach R2 endpoint` / `Cloudflare R2 error` → step 2.
   - `browser blocked the upload to R2` → step 4 (CORS).
   - `R2 rejected the upload (HTTP 403 ...)` → step 5 (token).
2. **Render logs** (Logs tab, search `NetworkingError` or `Error`).
   - `SSL_connect ... sslv3 alert handshake failure` → `R2_ENDPOINT` hostname is wrong.
3. **Check `R2_ENDPOINT`** exactly matches Cloudflare → R2 → bucket → Settings → "S3 API", **without** the `/bucket-name` on the end. Quick test from any terminal:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://<ACCOUNT_ID>.r2.cloudflarestorage.com/
   # 400 = hostname is valid. "handshake failure" = wrong account ID.
   ```
4. **CORS:** Cloudflare → R2 → bucket → Settings → CORS Policy must list the exact site origin (e.g. `https://tennis-live-s93z.onrender.com`, no trailing slash), methods GET/PUT/HEAD, headers Content-Type/Range.
5. **Token:** R2 API token needs **Object Read & Write** on this bucket. Recreate it if unsure and update both key vars in Render.
6. Confirm the upload landed: Cloudflare → R2 → bucket → Objects → `recordings/YYYY/MM/DD/`.

## 4. Debug "viewer can't see the stream"

- Both devices logged in with the right role? The viewer taps **Watch live** *after* the streamer taps **Start streaming**.
- Keeps saying "Reconnecting…" or drops on cellular → turn on the TURN relay (section 4a).
- Check it's active: logged in, open `/api/ice`. It should show `"relay":true` and `turn:` URLs.
- Render free tier asleep → first load takes about 50 s. Reload both devices once it's awake.
- Server restarted mid-session → both sides reload (the `epoch` change resets signaling).

## 4a. Turn on the Cloudflare TURN relay

1. Cloudflare dashboard → **Realtime** (Calls) → **TURN Server** → **Create** a TURN key.
2. Copy the **Turn Token ID** and **API Token** (the token is shown once).
3. Render → tennis-live → Environment → add `CF_TURN_KEY_ID` and `CF_TURN_KEY_API_TOKEN` → Save, rebuild, and deploy.
4. Verify with `/api/ice` (`"relay":true`). If the keys are wrong, Render logs show `TURN credentials unavailable` and the app quietly falls back to STUN.

## 5. Add a new video control (pattern)

1. Markup: add a `<button class="tool-btn">` inside `.video-tools` in `public/index.html` (top-right of the video), or a new overlay inside `#viewerBox`.
2. Logic: append a handler at the bottom of `public/app.js`, in the "Camera, zoom, full screen, picture-in-picture" section.
3. For anything the **viewer should also see**, change `outStream` (what's sent over WebRTC), not just the local `<video>` CSS.
4. Feature-detect, and give a fallback for iPhone Safari (see how full screen falls back to `.viewer.is-full`).
5. Test: desktop Chrome with a fake camera (section 1), then a real iPhone over HTTPS (the Render URL).

## 6. Add a server endpoint (pattern)

```ruby
get '/api/thing' do
  authenticated!          # requires login
  content_type :json
  r2_configured!          # only if it touches R2
  { ok: true }.to_json
end
```

- Return `{ error: "..." }` with a proper status code on failure. The frontend shows it.
- POSTs from the browser must be same-origin (enforced in the `before` filter).
- R2/AWS exceptions are already turned into readable JSON by the `error` handlers at the bottom of `server.rb`.

## 7. Rotate secrets

- Passwords: change `BROADCAST_PASSWORD` / `VIEWER_PASSWORD` in Render → Save & deploy. Everyone has to log in again.
- R2 keys: create a new token in Cloudflare → update both `R2_*KEY*` vars in Render → deploy → delete the old token.
- Session secret: changing `SESSION_SECRET` logs everyone out.

## 8. Using an LLM on this repo

- Point the agent at `AGENTS.md` first. Claude Code loads it automatically via `CLAUDE.md`.
- Good prompts name the device and browser ("on iPhone Safari, the zoom slider…") and paste the exact status-line or Render log message.
- Ask the agent to verify in a browser (local server + fake camera) before pushing.
- After a fix, ask it to add the lesson to **AGENTS.md → Known gotchas** or a recipe here.
