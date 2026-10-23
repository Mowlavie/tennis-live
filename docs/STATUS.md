# Project status & handoff

Living snapshot so any machine or AI agent can pick up where the last one left off.
**Update this file at the end of each work session.** No secrets here: values live in Render
and Cloudflare, and only names are listed.

_Last updated: 2026-10-23_

## Owner goals

- Grow Courtline from a two-person family prototype into a **tennis streaming business** (parents, coaches, clubs). See the roadmap in [AGENTS.md](../AGENTS.md).
- UI should look like a real product: plain copy, no marketing slogans or "AI-looking" styling.
- Keep docs current for humans and LLMs: `AGENTS.md` (context), `SKILLS.md` (how-tos), `docs/LEGAL.md` (compliance), this file (state).

## Where things live

| Thing | Location |
|---|---|
| Code | GitHub `Mowlavie/tennis-live`, branch `main` (push = production deploy) |
| Hosting | Render web service **tennis-live** (free plan), https://tennis-live-s93z.onrender.com |
| Video storage | Cloudflare R2 bucket **courtline-recordings** (ENAM), private; CORS allows the Render URL |
| Env vars (names) | `SESSION_SECRET`, `RACK_ENV`, `BROADCAST_PASSWORD`, `VIEWER_PASSWORD`, `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (all set). Not yet set: `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BROADCASTER_EMAILS`, `VIEWER_EMAILS` |

## Done

- 2026-10-22: Cloud saving fixed. `R2_ENDPOINT` on Render was missing the first 9 characters of the account ID, which caused an SSL handshake failure. Clearer R2 error messages.
- 2026-10-22: Streamer zoom (hardware or canvas), full screen (with iPhone fallback), picture-in-picture, wake lock, camera auto-resume.
- 2026-10-22: Viewer auto-reconnect (tap Watch live once), video survives server restarts, Cloudflare TURN support (needs keys), recording auto-saves when the browser is minimized and resumes as "part N".
- 2026-10-22: Production-style UI redesign (SVG icons, Library tabs, dark mode, no auto-downloads).
- 2026-10-23: Live group chat (overlay in full screen), Google sign-in with email allowlists, age/Terms consent gate (under-13 blocked, 13–17 guardian permission, adults-only streaming), filming-permission dialog, streamer can delete cloud videos, draft Terms/Privacy/Safety pages, `docs/LEGAL.md`.

## Next up (in rough priority)

1. **Set up Google sign-in** (SKILLS.md §4b) and set the email lists on Render.
2. **Turn on Cloudflare TURN** (SKILLS.md §4a) for reliable video on cellular.
3. **Lawyer review** of the legal pages; fill in the [bracketed] placeholders (company name, emails, state).
4. **Database (Postgres)**: users, courts/rooms, invites, consent records, chat history. This replaces the env email lists and in-memory state.
5. One-to-many streaming via an SFU (Cloudflare Realtime / LiveKit) for more than one viewer.
6. Chat moderation (report, delete message, remove viewer) and an account deletion flow.
7. Update `README.md`, which still describes the original prototype (says captures aren't uploaded).

## Known limits right now

- One streamer and one viewer at a time (peer-to-peer).
- Chat history, signaling and consent records live in server memory and logs, so a Render restart clears chat.
- Phones pause the camera when the browser is backgrounded; that's a platform limit, and only a native app could change it.
- Render free tier sleeps after inactivity (about a 50 s cold start).

## New machine setup

1. `git clone https://github.com/Mowlavie/tennis-live.git && cd tennis-live`
2. Install Ruby 3.4+ and Bundler, then `bundle install`.
3. Run locally: see SKILLS.md §1 (use throwaway local passwords; R2/Google vars are optional locally).
4. Claude Code reads `CLAUDE.md` → `AGENTS.md` automatically. Point it at this file for current state.
5. Log in to `gh`, Render and Cloudflare in the browser if an agent should operate them (the Claude in Chrome extension needs re-pairing on the new machine).
