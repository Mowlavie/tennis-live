const $ = id => document.getElementById(id);
const video = $('video');
let role = null, pc = null, camera = null, currentStream = null, recorder = null;
let chunks = [], lastId = 0, epoch = null, recordingType = '', polling = null;
let pendingCandidates = [], negotiating = false, clipNumber = 0, sessionRecorder = null, captureCount = 0;
let outStream = null, wakeLock = null; // outStream = what viewers and recordings get (zoomed when zoom is on)
// ICE servers come from /api/ice (Cloudflare TURN relay when configured, STUN otherwise).
let ICE = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }] }, iceLoadedAt = 0;
let wantWatch = false, reconnectTimer = null, reconnectTries = 0;
let me = {}, filmingOk = false, chatLast = 0, appStarted = false;
async function loadIce() {
  try { const r = await api('/api/ice'); if (r.iceServers && r.iceServers.length) { ICE = { iceServers: r.iceServers }; iceLoadedAt = Date.now(); } }
  catch (err) { console.warn('ICE config unavailable', err); }
}

function status(message) { $('status').textContent = message; }
function live(on) { $('liveBadge').textContent = on ? 'Live' : 'Offline'; $('liveBadge').classList.toggle('on', on); $('viewerBox').classList.toggle('has-video', on); $('status').classList.toggle('is-live', on); $('snapshot').disabled = !on; $('record').disabled = !on; $('zoomBox').hidden = !(on && role === 'broadcaster' && zoom.mode !== 'none'); }
async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  let data;
  try { data = await r.json(); } catch { throw new Error(`Server error (HTTP ${r.status})`); }
  if (!r.ok) { if (data.code === 'consent_required' && typeof showConsent === 'function') showConsent(); throw new Error(data.error || `Request failed (HTTP ${r.status})`); }
  return data;
}
async function send(type, payload = null) { return api('/signal', { method: 'POST', body: JSON.stringify({type, payload}) }); }
function showApp() {
  if (appStarted) return; appStarted = true;
  $('consentPanel').hidden = true;
  $('loginPanel').hidden = true; $('appPanel').hidden = false; $('sessionBar').hidden = false;
  $('roleLabel').textContent = role === 'broadcaster' ? 'Streaming' : 'Watching';
  $('viewerEmptyText').textContent = role === 'broadcaster' ? 'Camera is off. Tap Go live to start.' : 'Waiting for the stream. Tap Watch live.';
  $('start').hidden = role !== 'broadcaster'; $('connect').hidden = role !== 'viewer';
  $('stop').hidden = true;
  setupChatIdentity();
  startPolling(); loadCloud(); loadIce();
}
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/login', { method:'POST', body: JSON.stringify({password: $('password').value}) });
    $('password').value = ''; await afterSignIn();
  } catch(err) { $('loginError').textContent = err.message; }
});
$('logout').onclick = async () => { await shutDown(); clearInterval(polling); await api('/logout', {method:'POST',body:'{}'}); location.reload(); };
$('copyLink').onclick = async () => { try { await navigator.clipboard.writeText(location.origin); status('Invite link copied'); } catch { status(location.origin); } };

async function makePeer() {
  if (pc) pc.close(); pendingCandidates = [];
  if (Date.now() - iceLoadedAt > 6 * 3600 * 1000) await loadIce();
  const peer = pc = new RTCPeerConnection(ICE);
  pc.onicecandidate = e => { if(e.candidate) send('candidate', e.candidate.toJSON()).catch(console.error); };
  pc.onconnectionstatechange = () => {
    if (peer !== pc) return; // an older connection we already replaced
    const state = pc.connectionState;
    if (state === 'connected') { status('Live video connected'); reconnectTries = 0; clearTimeout(reconnectTimer); }
    if (state === 'disconnected') { status('Connection unstable… reconnecting'); scheduleReconnect(4000); }
    if (state === 'failed') { status('Connection dropped… reconnecting'); scheduleReconnect(0); }
  };
  pc.ontrack = e => { if(role === 'viewer') {
    currentStream = e.streams[0] || new MediaStream([e.track]);
    video.srcObject = currentStream; video.muted = false;
    video.play().catch(() => status('Tap the video to start playback'));
    startRecorder(currentStream); live(true);
  }};
  if(role === 'broadcaster' && outStream) outStream.getTracks().forEach(track => pc.addTrack(track,outStream));
}
async function flushCandidates() { while(pendingCandidates.length) await pc.addIceCandidate(pendingCandidates.shift()).catch(() => {}); }
async function offer() {
  if(!camera || negotiating) return;
  negotiating = true;
  try { await makePeer(); const desc = await pc.createOffer(); await pc.setLocalDescription(desc); await send('offer', pc.localDescription); }
  finally { negotiating = false; }
}
async function handle(e) {
  if(e.type === 'join' && role === 'broadcaster' && camera) await offer();
  if(e.type === 'offer' && role === 'viewer') {
    await makePeer(); await pc.setRemoteDescription(e.payload); await flushCandidates();
    const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); await send('answer', pc.localDescription);
  }
  if(e.type === 'answer' && role === 'broadcaster' && pc && pc.signalingState === 'have-local-offer') {
    await pc.setRemoteDescription(e.payload); await flushCandidates();
  }
  if(e.type === 'candidate') {
    if(!pc || !pc.remoteDescription) pendingCandidates.push(e.payload);
    else await pc.addIceCandidate(e.payload).catch(() => {});
  }
  if(e.type === 'leave') { if(pc) pc.close(); pc=null; if(role === 'viewer'){stopRecorder(); live(false); status(wantWatch ? 'Stream ended. Waiting for the broadcaster to go live again…' : 'Broadcaster ended the stream'); if (wantWatch) scheduleReconnect(5000);} }
}
async function poll() {
  try { const result = await api(`/events?after=${lastId}&chat_after=${chatLast}`);
    // Server restarted: reset counters and refetch next tick. The video is peer-to-peer, so keep it.
    if(epoch && result.epoch !== epoch) { epoch=result.epoch; lastId=0; chatLast=0; $('chatList').replaceChildren(); return; }
    epoch=result.epoch;
    renderChat(result.chat);
    for(const event of result.events) { lastId = Math.max(lastId,event.id); try { await handle(event); } catch(err) { console.error(err);status('Video negotiation error: '+err.message); } }
    lastId = Math.max(lastId, result.last_id);
  } catch(err) { status('Connection to server interrupted: '+err.message); }
}
function startPolling() { poll(); polling=setInterval(poll,1100); }
$('start').onclick = () => { if (filmingOk) goLive(); else { $('filmingError').textContent = ''; $('filmingDialog').showModal(); } };
async function goLive() {
  try {
    camera = await openCamera();
    outStream = setupZoom(camera);
    currentStream=outStream; video.srcObject=outStream; video.muted=true; await video.play();
    live(true); startRecorder(outStream); $('start').hidden=true; $('stop').hidden=false;
    requestWakeLock();
    status('You are live. Viewers can sign in and tap Watch live.');
  } catch(err) { status('Camera error: '+err.message); }
}
video.addEventListener('click', () => { if (video.paused) video.play().catch(() => status('Tap Watch live again to resume playback.')); });
$('connect').onclick = async () => { wantWatch = true; reconnectTries = 0; try { status('Requesting live video…'); requestWakeLock(); await send('join'); scheduleReconnect(8000); } catch(err) { status(err.message); } };
$('stop').onclick = async () => { await shutDown(); $('start').hidden=false; $('stop').hidden=true; status('Stream stopped'); };
async function shutDown() {
  wantWatch = false; clearTimeout(reconnectTimer); resumeRecording = false;
  if(role) try { await send('leave'); } catch {}
  if(pc) pc.close();pc=null;
  if(camera) camera.getTracks().forEach(t=>t.stop()); camera=null;
  stopZoom(); outStream=null; releaseWakeLock();
  if (sessionRecorder && sessionRecorder.state !== 'inactive') sessionRecorder.stop(); sessionRecorder=null; updateRecordingUI();
  stopRecorder(); currentStream=null; video.srcObject=null; live(false);
  // Keep signaling active until sign-out so the next session can reconnect.
}
function startRecorder(stream) {
  stopRecorder(); chunks=[];
  if(!window.MediaRecorder) { status('This browser cannot record clips. Try recent Safari or Chrome.'); return; }
  recordingType = ['video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(t=>MediaRecorder.isTypeSupported(t)) || '';
  try {
    recorder = new MediaRecorder(stream, recordingType ? {mimeType:recordingType} : {});
    recorder.ondataavailable = e => {
      if(e.data.size) { const t=Date.now(); chunks.push({data:e.data,time:t}); chunks=chunks.filter(c=>t-c.time<=32000); $('save').disabled=false; }
    };
    recorder.onerror = () => status('Clip recording failed');
    recorder.start(1000);
  } catch(err) { status('Unable to record highlights: '+err.message); }
}
function stopRecorder() {
  if(recorder && recorder.state!=='inactive') recorder.stop(); recorder=null;
  chunks=[]; $('save').disabled=true;
}
function fileStamp() { return new Date().toISOString().replace(/[:.]/g,'-'); }
const ICON = name => `<svg class="icon"><use href="#i-${name}"/></svg>`;
function makeCard({ src, photo, title, sub, href, filename, onDelete }) {
  const card = document.createElement('article'); card.className = 'capture-card';
  const preview = document.createElement('div'); preview.className = 'capture-preview';
  const media = document.createElement(photo ? 'img' : 'video');
  media.src = src;
  if (photo) { media.alt = title; media.loading = 'lazy'; }
  else { media.controls = true; media.playsInline = true; media.preload = 'metadata'; }
  preview.appendChild(media);
  const meta = document.createElement('div'); meta.className = 'capture-meta';
  const text = document.createElement('div');
  const t = document.createElement('strong'); t.textContent = title;
  const st = document.createElement('small'); st.textContent = sub;
  text.append(t, st);
  const link = document.createElement('a'); link.href = href; link.setAttribute('aria-label', `Download ${title}`); link.title = 'Download';
  if (filename) link.download = filename; else { link.target = '_blank'; link.rel = 'noopener'; }
  link.innerHTML = ICON('download');
  const actions = document.createElement('div'); actions.className = 'card-actions';
  actions.append(link);
  if (onDelete) {
    const del = document.createElement('button'); del.type = 'button'; del.title = 'Delete'; del.setAttribute('aria-label', `Delete ${title}`);
    del.innerHTML = ICON('trash');
    del.onclick = () => onDelete(card, del);
    actions.append(del);
  }
  meta.append(text, actions); card.append(preview, meta);
  return card;
}
function addCapture(blob, kind, filename) {
  const url = URL.createObjectURL(blob);
  const grid = $('clips');
  if (grid.querySelector('.empty')) grid.innerHTML = '';
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  grid.prepend(makeCard({ src: url, photo: kind === 'Photo', title: kind, sub: `${time} · ${formatSize(blob.size)}`, href: url, filename }));
  captureCount++; $('captureCount').textContent = captureCount;
  status(`${kind} captured. Uploading to the cloud…`);
  uploadToCloud(blob, kind).catch(err => status(`${kind} kept on this device, but the cloud upload failed: ${err.message}`));
}
function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
$('snapshot').onclick = async () => {
  try { const blob = await captureFrame(video); addCapture(blob,'Photo',`courtline-photo-${fileStamp()}.jpg`); }
  catch (err) { status(`Photo not saved: ${err.message}`); }
};
let recTicker = null;
function updateRecordingUI() {
  const on = !!sessionRecorder && sessionRecorder.state === 'recording';
  $('record').classList.toggle('recording', on);
  $('recordLabel').textContent = on ? 'Stop' : 'Record';
  $('recordHint').textContent = on ? 'Stop and save the video' : 'Record a full video';
  $('recBadge').hidden = !on;
  clearInterval(recTicker);
  if (on) {
    const started = Date.now();
    const tick = () => { const sec = Math.floor((Date.now() - started) / 1000); $('recTime').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };
    tick(); recTicker = setInterval(tick, 1000);
  }
}
$('record').onclick = () => {
  if (sessionRecorder && sessionRecorder.state === 'recording') {
    sessionRecorder.stop(); sessionRecorder=null; updateRecordingUI(); return;
  }
  recordingPart = 1;
  try { startSessionRecording(); status('Recording. Tap Stop to save the video.'); }
  catch(err) { status(`Recording not started: ${err.message}`); }
};
let recordingPart = 1, resumeRecording = false;
function startSessionRecording() {
  if (!currentStream || !currentStream.active) throw new Error('Start the stream first.');
  const part = recordingPart;
  // A standalone start-to-stop file is more reliable on Safari than joining arbitrary time slices.
  sessionRecorder = createSessionRecorder(currentStream, blob => {
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    addCapture(blob, part > 1 ? `Video (part ${part})` : 'Video', `courtline-video-${fileStamp()}.${ext}`);
  }, status);
  updateRecordingUI();
}
$('save').onclick = () => {
  if(!chunks.length) return;
  const mime = recorder?.mimeType || recordingType || 'video/webm';
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks.map(c=>c.data),{type:mime});
  const name=`courtline-highlight-${fileStamp()}-${++clipNumber}.${ext}`;
  addCapture(blob, '30s highlight (experimental)', name);
};
(async function init() {
  const authError = new URLSearchParams(location.search).get('auth_error');
  if (authError) { $('loginError').textContent = authError; history.replaceState(null, '', '/'); }
  try { await afterSignIn(); } catch (err) { console.error(err); }
})();

async function uploadToCloud(blob, kind) {
  const mime = blob.type.split(';')[0] || (kind === 'Photo' ? 'image/jpeg' : 'video/mp4');
  const ticket = await api('/api/uploads', {method:'POST', body:JSON.stringify({type:mime,size:blob.size})});
  let response;
  try { response = await fetch(ticket.url, {method:'PUT',headers:{'Content-Type':ticket.content_type},body:blob}); }
  catch { throw new Error(`browser blocked the upload to R2. Add ${location.origin} to the bucket's CORS AllowedOrigins`); }
  if(!response.ok) {
    const detail = (await response.text().catch(()=>'')).match(/<Code>([^<]+)<\/Code>/)?.[1] || '';
    throw new Error(`R2 rejected the upload (HTTP ${response.status}${detail ? ' ' + detail : ''}). Check R2 keys have Read & Write on this bucket`);
  }
  status(`${kind} saved to the cloud.`);
  await loadCloud();
}
async function loadCloud() {
  const gallery = $('cloudClips');
  $('refreshCloud').classList.add('spinning');
  try {
    const { items } = await api('/api/recordings');
    gallery.replaceChildren();
    if (!items.length) { gallery.innerHTML = '<div class="empty">Nothing saved to the cloud yet.</div>'; return; }
    for (const item of items) {
      const photo = /\.(jpg|png)$/i.test(item.key);
      const when = new Date(item.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      gallery.appendChild(makeCard({ src: item.url, photo, title: photo ? 'Photo' : 'Video', sub: `${when} · ${formatSize(item.size)}`, href: item.url,
        onDelete: role === 'broadcaster' ? (card, btn) => deleteCloudItem(item.key, card, btn) : null }));
    }
  } catch (err) {
    gallery.replaceChildren();
    const box = document.createElement('div'); box.className = 'empty error';
    box.textContent = `Couldn't load the cloud library. ${err.message}`;
    gallery.appendChild(box);
  } finally { $('refreshCloud').classList.remove('spinning'); }
}
$('refreshCloud').onclick = loadCloud;


// ---------- Camera, zoom, full screen, picture-in-picture ----------
function openCamera() {
  return navigator.mediaDevices.getUserMedia({video: { facingMode:'environment', width:{ideal:1280}, height:{ideal:720}}, audio:true});
}

// Uses the camera's own zoom when the browser exposes it; otherwise crops the
// picture through a canvas so viewers and recordings still see the zoom.
const zoom = { mode:'none', level:1, min:1, max:1, step:0.1, track:null, src:null, canvas:null, ctx:null, outTrack:null, loop:0 };
function setupZoom(cam) {
  stopZoom();
  const track = cam.getVideoTracks()[0];
  zoom.track = track; zoom.level = 1;
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    zoom.mode = 'hardware'; zoom.min = caps.zoom.min; zoom.max = Math.min(caps.zoom.max, caps.zoom.min * 10);
    zoom.step = caps.zoom.step || 0.1; zoom.level = track.getSettings().zoom || zoom.min;
    syncZoomUI(); return cam;
  }
  const canvas = document.createElement('canvas');
  if (!track || !canvas.captureStream) { zoom.mode = 'none'; return cam; }
  const src = document.createElement('video');
  src.muted = true; src.playsInline = true; src.setAttribute('playsinline', '');
  src.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:0;top:0';
  document.body.appendChild(src);
  src.srcObject = new MediaStream([track]); src.play().catch(() => {});
  const settings = track.getSettings();
  canvas.width = settings.width || 1280; canvas.height = settings.height || 720;
  Object.assign(zoom, { mode:'digital', min:1, max:4, step:0.1, src, canvas, ctx: canvas.getContext('2d') });
  const draw = () => {
    if (zoom.mode !== 'digital') return;
    const vw = src.videoWidth, vh = src.videoHeight;
    if (vw && vh) {
      if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh; }
      const w = vw / zoom.level, h = vh / zoom.level;
      zoom.ctx.drawImage(src, (vw - w) / 2, (vh - h) / 2, w, h, 0, 0, vw, vh);
    }
    zoom.loop = requestAnimationFrame(draw);
  };
  draw();
  zoom.outTrack = canvas.captureStream(30).getVideoTracks()[0];
  syncZoomUI();
  return new MediaStream([zoom.outTrack, ...cam.getAudioTracks()]);
}
function stopZoom() {
  cancelAnimationFrame(zoom.loop);
  if (zoom.outTrack) zoom.outTrack.stop();
  if (zoom.src) { zoom.src.srcObject = null; zoom.src.remove(); }
  Object.assign(zoom, { mode:'none', level:1, track:null, src:null, canvas:null, ctx:null, outTrack:null });
  $('zoomBox').hidden = true;
}
function syncZoomUI() {
  const r = $('zoomRange');
  r.min = zoom.min; r.max = zoom.max; r.step = zoom.step; r.value = zoom.level;
  $('zoomLabel').textContent = `${(zoom.level / zoom.min).toFixed(1)}×`;
}
function setZoom(value) {
  if (zoom.mode === 'none') return;
  zoom.level = Math.min(zoom.max, Math.max(zoom.min, Number(value) || zoom.min));
  if (zoom.mode === 'hardware' && zoom.track) zoom.track.applyConstraints({ advanced: [{ zoom: zoom.level }] }).catch(() => {});
  syncZoomUI();
}
$('zoomRange').addEventListener('input', e => setZoom(e.target.value));
$('zoomIn').onclick = () => setZoom(zoom.level + (zoom.max - zoom.min) / 10);
$('zoomOut').onclick = () => setZoom(zoom.level - (zoom.max - zoom.min) / 10);

// Pinch on the video to zoom (streamer only).
let pinch = null;
const touchGap = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
$('viewerBox').addEventListener('touchstart', e => {
  if (role === 'broadcaster' && zoom.mode !== 'none' && e.touches.length === 2) pinch = { gap: touchGap(e.touches), level: zoom.level };
}, { passive: true });
$('viewerBox').addEventListener('touchmove', e => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  setZoom(pinch.level * touchGap(e.touches) / pinch.gap);
}, { passive: false });
$('viewerBox').addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; });

// Full screen: real full screen where supported, otherwise fill the page (iPhone Safari).
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
function setFakeFull(on) {
  $('viewerBox').classList.toggle('is-full', on);
  document.body.classList.toggle('no-scroll', on);
  updateFullButton();
}
function updateFullButton() {
  const on = !!fsElement() || $('viewerBox').classList.contains('is-full');
  $('fullBtn').classList.toggle('is-on', on);
  $('fullBtn').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
}
$('fullBtn').onclick = async () => {
  const box = $('viewerBox');
  if (fsElement()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
  if (box.classList.contains('is-full')) { setFakeFull(false); return; }
  const request = box.requestFullscreen || box.webkitRequestFullscreen;
  if (!request) { setFakeFull(true); return; }
  try {
    await request.call(box);
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch { setFakeFull(true); }
};
document.addEventListener('fullscreenchange', updateFullButton);
document.addEventListener('webkitfullscreenchange', updateFullButton);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('viewerBox').classList.contains('is-full')) setFakeFull(false); });

// Picture-in-picture: keep the video floating while using other apps.
const pipSupported = (document.pictureInPictureEnabled && !video.disablePictureInPicture) || typeof video.webkitSetPresentationMode === 'function';
$('pipBtn').hidden = !pipSupported;
$('pipBtn').onclick = async () => {
  try {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
    if (video.webkitPresentationMode === 'picture-in-picture') { video.webkitSetPresentationMode('inline'); return; }
    if (!video.srcObject) { status('Start or join the stream first, then tap picture-in-picture.'); return; }
    if (document.pictureInPictureEnabled) await video.requestPictureInPicture();
    else video.webkitSetPresentationMode('picture-in-picture');
    if (role === 'broadcaster') status('Floating preview on. Note: phones pause the camera if you leave the browser, so viewers may see a frozen picture until you come back.');
  } catch (err) { status(`Picture-in-picture not available: ${err.message}`); }
};

// Keep the screen awake while streaming or watching.
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWakeLock() { if (wakeLock) wakeLock.release().catch(() => {}); wakeLock = null; }

// When the streamer comes back from another app, restart the camera if the phone stopped it.
async function restartCamera() {
  const fresh = await openCamera();
  const v = fresh.getVideoTracks()[0], a = fresh.getAudioTracks()[0];
  if (camera) camera.getTracks().forEach(t => t.stop());
  camera = fresh;
  let outVideo = v;
  if (zoom.mode === 'digital') { zoom.src.srcObject = new MediaStream([v]); zoom.src.play().catch(() => {}); outVideo = zoom.outTrack; }
  else { zoom.track = v; if (zoom.mode === 'hardware') setZoom(zoom.level); }
  outStream = new MediaStream([outVideo, a].filter(Boolean));
  currentStream = outStream; video.srcObject = outStream; video.play().catch(() => {});
  if (pc) for (const sender of pc.getSenders()) {
    const kind = sender.track && sender.track.kind;
    if (kind === 'video' && sender.track !== outVideo) await sender.replaceTrack(outVideo);
    if (kind === 'audio' && a) await sender.replaceTrack(a);
  }
  startRecorder(outStream);
  status('Camera resumed. You are live again.');
}
// Phones pause the camera when the browser is minimized or the screen locks, and a
// website cannot prevent that. So: save + upload what was recorded so far the moment
// the page is hidden, then start a new part automatically when the user comes back.
function pipActive() { return !!document.pictureInPictureElement || video.webkitPresentationMode === 'picture-in-picture'; }
function saveRecordingBeforeHide() {
  if (!sessionRecorder || sessionRecorder.state !== 'recording') return;
  if (role === 'viewer' && pipActive()) return; // video keeps playing in the floating window
  resumeRecording = true;
  sessionRecorder.stop(); sessionRecorder = null; updateRecordingUI();
}
window.addEventListener('pagehide', saveRecordingBeforeHide);
window.addEventListener('beforeunload', e => { if (sessionRecorder && sessionRecorder.state === 'recording') { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') { saveRecordingBeforeHide(); return; }
  if (camera || role === 'viewer') requestWakeLock();
  if (role === 'broadcaster' && camera) {
    const dead = () => { const t = camera && camera.getVideoTracks()[0]; return !t || t.readyState === 'ended' || t.muted; };
    // A paused camera often wakes up on its own; give it a moment before restarting it.
    if (dead()) await new Promise(r => setTimeout(r, 1500));
    if (camera && dead()) {
      try { await restartCamera(); } catch (err) { status(`Camera did not resume: ${err.message}. Tap End stream, then Start streaming.`); }
    }
  }
  if (video.srcObject && video.paused) video.play().catch(() => {});
  if (resumeRecording) {
    resumeRecording = false;
    try {
      // Give the camera/stream a moment to come back before recording again.
      await new Promise(r => setTimeout(r, 800));
      recordingPart++; startSessionRecording();
      status(`Welcome back. Your earlier video was saved; recording part ${recordingPart} now.`);
    } catch (err) { status(`Earlier video saved. Recording did not restart: ${err.message}`); }
  }
});


// ---------- Automatic reconnect ----------
// The viewer taps Watch live once; after that we keep asking for video until it is
// connected, and again whenever it drops (network change, broadcaster restarts, etc.).
function scheduleReconnect(delay) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (pc && pc.connectionState === 'connected') return;
    if (role === 'viewer' && wantWatch) {
      reconnectTries++;
      if (reconnectTries > 1) status(`Reconnecting to live video… (attempt ${reconnectTries})`);
      try { await send('join'); } catch {}
      scheduleReconnect(Math.min(20000, 6000 + reconnectTries * 2000)); // check again; back off slowly
    }
  }, delay);
}
window.addEventListener('online', () => { if (role === 'viewer' && wantWatch) scheduleReconnect(500); });


// ---------- Library tabs ----------
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => {
    const on = t === tab;
    t.setAttribute('aria-selected', on);
    $(t.dataset.tab).hidden = !on;
  });
}));


// ---------- Sign-in, age confirmation, filming permission ----------
async function afterSignIn() {
  me = await api('/me');
  $('googleBtn').hidden = !me.google; $('orDivider').hidden = !me.google;
  if (!me.role) return;
  role = me.role; filmingOk = !!me.filming_ok;
  $('loginPanel').hidden = true;
  if (me.consent) showApp(); else showConsent();
}
function showConsent() {
  if (appStarted) { location.reload(); return; } // terms changed mid-session: start clean
  $('loginPanel').hidden = true; $('appPanel').hidden = true; $('consentPanel').hidden = false;
}
$('consentForm').addEventListener('change', () => {
  const age = ($('consentForm').querySelector('input[name=age]:checked') || {}).value;
  $('guardianRow').hidden = age !== 'teen';
});
$('consentForm').addEventListener('submit', async e => {
  e.preventDefault();
  const age = ($('consentForm').querySelector('input[name=age]:checked') || {}).value;
  $('consentError').textContent = '';
  try {
    await api('/api/consent', { method: 'POST', body: JSON.stringify({ age, terms: $('termsCheck').checked, guardian: $('guardianCheck').checked }) });
    me.consent = true; showApp();
  } catch (err) {
    $('consentError').textContent = err.message;
    if (age === 'child') setTimeout(() => location.reload(), 6000);
  }
});
$('consentSignOut').onclick = async () => { await api('/logout', { method: 'POST', body: '{}' }).catch(() => {}); location.reload(); };

$('filmingCancel').onclick = () => $('filmingDialog').close();
$('filmingForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!$('filmingCheck').checked || !$('eventCheck').checked) { $('filmingError').textContent = 'Please confirm both to go live.'; return; }
  try {
    await api('/api/filming-consent', { method: 'POST', body: JSON.stringify({ confirmed: true }) });
    filmingOk = true; $('filmingDialog').close(); goLive();
  } catch (err) { $('filmingError').textContent = err.message; }
});

async function deleteCloudItem(key, card, btn) {
  if (btn.dataset.armed !== '1') { // tap twice to delete, no browser pop-ups
    btn.dataset.armed = '1'; btn.title = 'Tap again to delete'; btn.style.color = 'var(--danger)';
    status('Tap the delete button again to permanently delete this file.');
    setTimeout(() => { btn.dataset.armed = ''; btn.style.color = ''; btn.title = 'Delete'; }, 4000);
    return;
  }
  try { await api('/api/recordings/delete', { method: 'POST', body: JSON.stringify({ key }) }); card.remove(); status('Deleted from the cloud.'); }
  catch (err) { status(`Could not delete: ${err.message}`); }
}

// ---------- Live chat ----------
function setupChatIdentity() {
  const needName = !me.name;
  $('chatName').hidden = !needName;
  if (needName) { try { $('chatName').value = localStorage.getItem('courtline-chat-name') || ''; } catch {} }
  $('chatWho').textContent = me.name ? `as ${me.name}` : '';
}
function chatTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function renderChat(messages) {
  if (!messages || !messages.length) return;
  const list = $('chatList');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const empty = list.querySelector('.chat-empty'); if (empty) empty.remove();
  for (const m of messages) {
    chatLast = Math.max(chatLast, m.id);
    const row = document.createElement('div'); row.className = 'chat-msg';
    const name = document.createElement('b'); name.textContent = m.name; if (m.role === 'broadcaster') name.className = 'host';
    const text = document.createElement('span'); text.textContent = m.text;
    const time = document.createElement('time'); time.textContent = chatTime(m.at);
    row.append(name, text, time); list.append(row);
    showBubble(m);
  }
  while (list.children.length > 300) list.firstChild.remove();
  if (nearBottom) list.scrollTop = list.scrollHeight;
  const full = $('viewerBox').classList.contains('is-full') || !!fsElement(); // overlay already shows messages
  const rect = $('chatPanel').getBoundingClientRect();
  if (!full && (rect.top > innerHeight || rect.bottom < 0)) $('chatUnread').hidden = false;
}
function showBubble(m) {
  const box = $('chatOverlay');
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  const name = document.createElement('b'); name.textContent = m.name;
  bubble.append(name, document.createTextNode(m.text));
  box.append(bubble);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => bubble.classList.add('fade'), 7000);
  setTimeout(() => bubble.remove(), 7700);
}
async function sendChat(text, input) {
  text = text.trim(); if (!text) return;
  const name = $('chatName').value.trim();
  if (!me.name && !name) { $('chatError').textContent = 'Add your name first.'; $('chatName').focus(); return; }
  $('chatError').textContent = '';
  try {
    const msg = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text, name }) });
    if (!me.name) { try { localStorage.setItem('courtline-chat-name', name); } catch {} me.name = msg.name; setupChatIdentity(); }
    input.value = '';
    if (msg.id > chatLast) renderChat([msg]);
  } catch (err) { $('chatError').textContent = err.message; }
}
$('chatForm').addEventListener('submit', e => { e.preventDefault(); sendChat($('chatInput').value, $('chatInput')); });
$('overlayChatForm').addEventListener('submit', e => { e.preventDefault(); sendChat($('overlayChatInput').value, $('overlayChatInput')); });
$('chatBtn').onclick = () => {
  $('chatUnread').hidden = true;
  const full = $('viewerBox').classList.contains('is-full') || !!fsElement();
  if (full) { const open = $('viewerBox').classList.toggle('chat-open'); if (open) $('overlayChatInput').focus(); }
  else { $('chatPanel').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('chatInput').focus({ preventScroll: true }); }
};
