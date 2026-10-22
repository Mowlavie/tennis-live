# Courtline — private tennis streaming

A mobile-first Ruby/Sinatra tennis streaming **prototype** for two people. Zero Rails. Password-protected private broadcast, one-to-one WebRTC viewing, still photos, full video recording, and experimental replay of the preceding 30 seconds.

## Upload and deploy

1. Upload all files **inside** this folder to your private GitHub repository `Mowlavie/tennis-live`, preserving the `public/` folder. Do not upload the ZIP itself as the app.
2. In Render choose **New > Web Service**, connect that repository, select Ruby and the Free plan. Build: `bundle install`. Start: `bundle exec puma -p ${PORT:-10000} -e production config.ru`. Or create from the included `render.yaml` blueprint.
3. In the service's Environment page set `RACK_ENV=production`, `SESSION_SECRET` to a cryptographically random secret of at least 64 characters, `BROADCAST_PASSWORD` to your own strong password, and `VIEWER_PASSWORD` to a **different** strong password for your spouse. Render blueprints can generate `SESSION_SECRET` for you.
4. Deploy, visit your `https://...onrender.com` address, sign in from a phone with broadcaster password, and tap **Start streaming**. A viewer signs in on another device with viewer password and taps **Watch live**.
5. Keep the broadcast page in the foreground. Use **Snapshot** for an image or **Record video**, then **Stop & save**, for an independently playable full clip. Video files and screenshots are downloaded to the device. Check the browser's Downloads, Files app, and share sheet on iOS; move the files to Photos as desired.

### Local run

```bash
bundle install
SESSION_SECRET="$(ruby -rsecurerandom -e 'puts SecureRandom.hex(48)')" \
BROADCAST_PASSWORD='replace-with-strong-secret' VIEWER_PASSWORD='another-strong-secret' \
bundle exec rackup -p 9292
```

## iPhone / Safari notes

- Camera requires HTTPS (Render supplies it). Use recent iOS Safari, grant camera/microphone permissions, keep the page visible and unlocked. Browser recording support and file format vary by iOS version.
- `Snapshot` saves a JPG. `Record video` captures continuously from Start to Stop with `MediaRecorder`, which is more robust than exporting partial slices of a rolling recording; for long clips monitor free device storage and memory.
- `Last 30s` is **experimental**: arbitrary `MediaRecorder` chunks may not contain headers/keyframes needed for a playable standalone MP4/WebM, particularly on iOS. Prefer recording a complete clip; building reliable retrospective video clipping requires a segment-aware recorder or server-side media processing.
- Captures are **not uploaded to Render** and are **not persisted in the app**; on-screen gallery links disappear when you leave or reload the page. Download each item and save it in Files/Photos before closing the tab. Full-session recording is held in memory until saved; stopping/closing Safari unexpectedly can lose the recording.
- iOS Safari may not autoplay audio. Tap the video if a viewer needs to initiate playback.
- Some networks (carrier NAT, restrictive Wi-Fi) block direct WebRTC. STUN-only is included; reliable connections over all networks require TURN, potentially with paid bandwidth.
- This prototype is limited to **one broadcaster and one viewer**. Both use shared role passwords (not unique user accounts); signals live only in a single server's memory, and Render free services spin down/restart. Render's temporary disk isn't persistent. This is not a production SaaS. For commercial release add proper per-user auth, room-scoped signaling, durable storage, server-side clip segmentation, TURN, rate limiting, and privacy/security testing.

## Project files

- `server.rb` — Sinatra sessions, login, and signaling
- `public/index.html` / `style.css` — responsive Courtline interface
- `public/app.js` — WebRTC and capture controls
- `public/recording.js` — screenshot and complete recording helpers
- `render.yaml` — free Render web service definition
