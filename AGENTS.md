# AGENTS.md — Courtline (tennis-live)

Context for AI coding agents (Claude Code, Codex, Cursor, etc.) and new developers.
Read this first. Step-by-step procedures live in [SKILLS.md](SKILLS.md).

## What this is

Courtline is a private, mobile-first live tennis streaming app. One person films a
match on their phone; family or a coach watches live on another device. Either side can
grab snapshots, record full videos, and save them to a private cloud library.

Today it is a **two-person prototype** (one streamer, one viewer, shared passwords).
The goal is to grow it into a business (see "Business direction" below), so prefer
changes that move toward multi-user and multi-court use rather than deepening
prototype shortcuts.

## Stack

| Piece | Tech | Notes |
|---|---|---|
| Server | Ruby 3.4, Sinatra 4, Puma | Single file: `server.rb` |
| Frontend | Plain HTML/CSS/JS, no build step | `public/` |
| Live video | WebRTC, peer-to-peer | Cloudflare TURN relay via `/api/ice` when `CF_TURN_*` set, else STUN only |
| Signaling | HTTP polling (`/events`, `/signal`) | In-memory, single process |
| Storage | Cloudflare R2 (S3-compatible) via `aws-sdk-s3` | Browser uploads directly with presigned URLs |
| Hosting | Render free web service | Auto-deploys on push to `main` |

## File map

- `server.rb` — login (role passwords → session), WebRTC signaling queue, R2 presigned upload/list endpoints, JSON error handlers.
- `config.ru` — Rack entry point.
- `public/index.html` — the whole UI (login card + app panel).
- `public/app.js` — WebRTC, polling, capture gallery, cloud upload/list, zoom, full screen, picture-in-picture, wake lock, camera auto-resume.
- `public/recording.js` — `saveFile`, `captureFrame` (snapshot), `createSessionRecorder` (start→stop video).
- `public/style.css` — all styles. Colors are CSS variables on `:root` with a dark-mode override; icons are inline SVG `<symbol>`s at the top of `index.html` (`<use href="#i-name">`).
- `render.yaml` — Render blueprint, lists every required env var.
- `r2-cors.json` — CORS policy to paste into the R2 bucket.
- `R2-SETUP.md` — first-time Cloudflare R2 setup.

## How it works

1. **Login.** `POST /login` compares the password with `BROADCAST_PASSWORD` or `VIEWER_PASSWORD` and stores `role` (`broadcaster` | `viewer`) in a signed cookie session.
2. **Signaling.** Clients poll `GET /events?after=N` about once a second. `POST /signal` puts `join|offer|answer|candidate|leave` messages into an in-memory queue addressed to the other role. `epoch` resets clients when the server restarts.
3. **Streaming.** The broadcaster calls `getUserMedia`, sends `outStream` (the camera, or a canvas-cropped copy when digital zoom is used) over `RTCPeerConnection`. The viewer sends `join`, and the broadcaster replies with an offer.
4. **Zoom.** If the camera supports `track.getCapabilities().zoom`, the app uses hardware zoom (`applyConstraints`). Otherwise it draws a cropped image to a canvas and sends `canvas.captureStream(30)`. Viewers, snapshots and recordings all see the zoomed picture.
5. **Capture.** Snapshot = canvas JPEG of the `<video>`. Record = `MediaRecorder` start→stop. "Last 30s" = rolling 1-second chunks (experimental, often unplayable on iOS).
6. **Cloud save.** `POST /api/uploads` → server returns a 10-minute presigned PUT URL → the browser PUTs the blob straight to R2. `GET /api/recordings` lists the latest 100 objects under `recordings/` with 15-minute presigned GET URLs.

## Environment variables

| Var | Purpose |
|---|---|
| `SESSION_SECRET` | Cookie signing (64+ chars) |
| `BROADCAST_PASSWORD` / `VIEWER_PASSWORD` | Role passwords |
| `RACK_ENV` | `production` on Render (secure cookies) |
| `R2_BUCKET` | Bucket name, e.g. `courtline-recordings` |
| `R2_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`: **account ID only, no bucket path** |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token (Object Read & Write, scoped to the bucket) |
| `CF_TURN_KEY_ID` / `CF_TURN_KEY_API_TOKEN` | Cloudflare Realtime TURN key. Optional, but needed for reliable video on cellular |

Never commit real values. `.env` is gitignored.

## Conventions

- UI tone: plain, product-style copy ("Go live", "Record", "Library"). No marketing slogans, all-caps eyebrow labels or emoji/unicode glyph icons.

- No frontend build tools or frameworks. Keep it plain JS that runs on iOS Safari.
- `$` is `document.getElementById`. Keep DOM ids stable; app.js relies on them.
- Server responses are JSON with an `error` key on failure. The client `api()` helper shows `error` to the user.
- User-facing errors must say what to fix (which setting, which permission), not just "failed".
- Test on **iPhone Safari** for anything touching camera, video, full screen or recording. Desktop Chrome hides most iOS problems.
- Ruby syntax check: `ruby -c server.rb`. There is no test suite yet.

## Known gotchas (learned the hard way)

- **R2 "sslv3 alert handshake failure"** in Render logs = wrong `R2_ENDPOINT` hostname (typo in the account ID). Cloudflare rejects unknown hostnames during the secure-connection handshake. This exact bug happened on 2026-10-22 (the first 9 characters of the account ID were missing).
- Upload fails in the browser with a network/"blocked" error = bucket CORS `AllowedOrigins` doesn't match the site URL.
- iPhone Safari has **no element full screen**. The app falls back to a fixed, fill-the-page layout (`.viewer.is-full`).
- Phones **pause the camera when the browser is backgrounded**. A website can't stream from the background. The app restarts the camera on return (`visibilitychange` → `restartCamera`).
- **Recording while minimized is impossible on the web.** On `visibilitychange: hidden`/`pagehide` the app stops and saves (uploads) the current recording, then starts "part N" automatically on return (`resumeRecording`). True background recording needs a native app.
- Picture-in-picture works for **viewers** multitasking. It does not keep the streamer's camera alive.
- STUN-only WebRTC fails or drops on cellular/corporate networks. Set `CF_TURN_*` so `/api/ice` hands out Cloudflare TURN relay credentials (cached 12 h, port-53 URLs removed because browsers block them).
- **Viewer auto-reconnect:** after one tap on Watch live (`wantWatch = true`), the viewer re-sends `join` on `disconnected`/`failed`, after the broadcaster leaves, and when the network comes back. Don't reintroduce "tap again to reconnect" flows.
- A server restart (new `epoch`) must **not** close the peer connection. Video is peer-to-peer and survives Render restarts.
- Polling vs WebSocket: signaling only sets up the call. Switching to WebSocket speeds up connecting but does **not** fix mid-stream drops (those are network/TURN issues).
- Render free tier sleeps after inactivity (around 50 s cold start) and wipes in-memory signaling on restart.
- `aws-sdk-s3` ≥ 1.178 adds checksum features. Presigned PUT URLs were verified clean with 1.235.0, but recheck after upgrading the gem.

## Business direction (scale-up roadmap)

Target users: tennis parents, juniors, coaches, clubs and academies. Later, other racket sports.

Rough order of work to turn the prototype into a product:

1. **Accounts & rooms.** Real user accounts (email/passkey), "courts"/rooms with invite links, replacing the two shared passwords. Per-user/per-team storage prefixes in R2.
2. **Reliability.** TURN is wired to Cloudflare (needs keys set); next: WebSocket or managed signaling instead of polling, persistent DB (Postgres) instead of in-memory state, paid Render instance.
3. **Recording at scale.** Chunked/resumable uploads (R2 multipart), uploads during the stream rather than after, server-side clipping for a real "last 30 seconds", storage quotas and lifecycle rules.
4. **Multi-viewer.** One-to-many through an SFU (Cloudflare Calls, LiveKit, mux) instead of peer-to-peer.
5. **Native/PWA.** Installable PWA first. Native iOS/Android later for background streaming, better zoom and lens control.
6. **Monetization ideas.** Freemium (free live, paid cloud storage), coach/club subscription tiers, highlight reels, score overlay, AI shot tagging and stats (LLM/vision on uploaded clips).
7. **Trust & compliance.** Minors on camera → privacy policy, consent, data deletion, COPPA/GDPR review, audit logs.

## Instructions for agents

- Read `SKILLS.md` for deploy, debugging and feature recipes before improvising.
- Don't put secrets, account IDs or passwords in code, docs, logs or commits.
- Pushing to `main` deploys to production on Render. Only push when the user asks.
- Keep the app working on iPhone Safari after every change.
- Update this file (gotchas, architecture) and `SKILLS.md` when you learn something non-obvious.
