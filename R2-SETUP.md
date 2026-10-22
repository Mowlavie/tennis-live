# Courtline private cloud recording setup

1. In Cloudflare R2 > Overview > Manage R2 API Tokens, create an Object Read & Write token scoped **only to your Courtline bucket**. Save its Access Key ID and Secret Access Key privately.
2. In Render > Courtline > Environment set:
   - `R2_BUCKET` to your bucket's name (e.g. `courtline-recordings`)
   - `R2_ENDPOINT` to `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` from Cloudflare
   - `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` to the token's S3 credentials
3. In Cloudflare > R2 > bucket > Settings > CORS Policy, paste `r2-cors.json`, replacing YOUR-RENDER-SERVICE with your real deployed hostname. Do NOT make bucket public.
4. Push these files to GitHub; regenerate and commit `Gemfile.lock` with Bundler before the Render deploy.
5. Log in and capture a photo, then Refresh Cloud replays. Record Video, Stop & Save to upload a full file.

## Important limitations
- Uploads occur after capture completes, not continuously during streaming. An interrupted Safari session may lose its unuploaded recording. Keep browser foregrounded.
- Each file must be <=150 MB. For large match videos, chunked resumable uploading and storage quotas are needed.
- Cloud objects are private; viewing uses 15-minute signed links. The library only lists the 100 most recent objects; there is no pagination yet.
- This is a private-family prototype, not a multi-tenant SaaS: passwords are shared roles, there are no individual accounts/audit logs, and R2 has no per-user object isolation yet.
- Browser upload links are valid for 10 minutes. Each successful capture can still be downloaded to the device.
- The experimental Last 30s action may produce invalid clips in Safari and must be reworked before commercial release.
