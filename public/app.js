const $ = id => document.getElementById(id);
const video = $('video');
let role = null, pc = null, camera = null, currentStream = null, recorder = null;
let chunks = [], lastId = 0, epoch = null, recordingType = '', polling = null;
let pendingCandidates = [], negotiating = false, clipNumber = 0, sessionRecorder = null, captureCount = 0;
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // No TURN: some networks cannot connect.

function status(message) { $('status').textContent = message; }
function live(on) { $('liveBadge').textContent = on ? '● LIVE' : 'OFF AIR'; $('liveBadge').classList.toggle('on', on); $('snapshot').disabled = !on; $('record').disabled = !on; }
async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function send(type, payload = null) { return api('/signal', { method: 'POST', body: JSON.stringify({type, payload}) }); }
function showApp() {
  $('loginPanel').hidden = true; $('appPanel').hidden = false;
  $('roleLabel').textContent = role === 'broadcaster' ? 'Broadcasting account' : 'Viewing account';
  $('start').hidden = role !== 'broadcaster'; $('connect').hidden = role !== 'viewer';
  $('stop').hidden = true;
  startPolling(); loadCloud();
}
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { const data = await api('/login', { method:'POST', body: JSON.stringify({password: $('password').value}) });
    $('password').value = ''; role = data.role; showApp();
  } catch(err) { $('loginError').textContent = err.message; }
});
$('logout').onclick = async () => { await shutDown(); clearInterval(polling); await api('/logout', {method:'POST',body:'{}'}); location.reload(); };
$('copyLink').onclick = async () => { try { await navigator.clipboard.writeText(location.origin); status('Link copied'); } catch { status(location.origin); } };

async function makePeer() {
  if (pc) pc.close(); pendingCandidates = [];
  pc = new RTCPeerConnection(ICE);
  pc.onicecandidate = e => { if(e.candidate) send('candidate', e.candidate.toJSON()).catch(console.error); };
  pc.onconnectionstatechange = () => { if (pc && pc.connectionState === 'connected') status('Live video connected');
    if (pc && ['failed','disconnected'].includes(pc.connectionState)) status('Connection lost. Try reconnecting; some networks require a TURN relay.'); };
  pc.ontrack = e => { if(role === 'viewer') {
    currentStream = e.streams[0] || new MediaStream([e.track]);
    video.srcObject = currentStream; video.muted = false;
    video.play().catch(() => status('Tap the video to start playback'));
    startRecorder(currentStream); live(true);
  }};
  if(role === 'broadcaster' && camera) camera.getTracks().forEach(track => pc.addTrack(track,camera));
}
async function flushCandidates() { while(pendingCandidates.length) await pc.addIceCandidate(pendingCandidates.shift()); }
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
    else await pc.addIceCandidate(e.payload);
  }
  if(e.type === 'leave') { if(pc) pc.close(); pc=null; if(role === 'viewer'){stopRecorder(); live(false); status('Broadcaster ended the stream');} }
}
async function poll() {
  try { const result = await api(`/events?after=${lastId}`);
    if(epoch && result.epoch !== epoch) { lastId=0; if(pc) pc.close(); pc=null; }
    epoch=result.epoch;
    for(const event of result.events) { lastId = Math.max(lastId,event.id); try { await handle(event); } catch(err) { console.error(err);status('Video negotiation error: '+err.message); } }
    lastId = Math.max(lastId, result.last_id);
  } catch(err) { status('Connection to server interrupted: '+err.message); }
}
function startPolling() { poll(); polling=setInterval(poll,1100); }
$('start').onclick = async () => {
  try {
    camera = await navigator.mediaDevices.getUserMedia({video: { facingMode:'environment', width:{ideal:1280},height:{ideal:720}}, audio:true});
    currentStream=camera; video.srcObject=camera; video.muted=true; await video.play();
    live(true); startRecorder(camera); $('start').hidden=true; $('stop').hidden=false;
    status('Camera ready. Your viewer can log in and tap Connect. Keep this page open.');
  } catch(err) { status('Camera error: '+err.message); }
};
video.addEventListener('click', () => { if (video.paused) video.play().catch(() => status('Tap Watch live again to resume playback.')); });
$('connect').onclick = async () => { try { status('Requesting live video…'); await send('join'); } catch(err) { status(err.message); } };
$('stop').onclick = async () => { await shutDown(); $('start').hidden=false; $('stop').hidden=true; status('Stream stopped'); };
async function shutDown() {
  if(role) try { await send('leave'); } catch {}
  if(pc) pc.close();pc=null;
  if(camera) camera.getTracks().forEach(t=>t.stop()); camera=null;
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
function addCapture(blob, kind, filename) {
  const url = saveFile(blob, filename);
  const grid = $('clips');
  if (grid.querySelector('.empty')) grid.innerHTML = '';
  const card = document.createElement('article'); card.className='capture-card';
  const preview = document.createElement('div'); preview.className='capture-preview';
  if (kind === 'Photo') { const img = document.createElement('img'); img.src=url; img.alt='Saved tennis screenshot'; preview.appendChild(img); }
  else { const vid = document.createElement('video'); vid.src=url; vid.controls=true; vid.playsInline=true; vid.preload='metadata'; preview.appendChild(vid); }
  const meta = document.createElement('div'); meta.className='capture-meta';
  const title=document.createElement('strong'); title.textContent=kind;
  const time=document.createElement('small'); time.textContent=new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  const link=document.createElement('a'); link.href=url; link.download=filename; link.textContent='Save to device ↗';
  meta.append(title,time,link); card.append(preview,meta); grid.prepend(card);
  captureCount++; $('captureCount').textContent=`${captureCount} item${captureCount===1?'':'s'}`;
  status(`${kind} saved locally. Uploading to your cloud library…`);
  uploadToCloud(blob, kind).catch(err => status(`Local capture saved; cloud upload failed: ${err.message}`));
}
$('snapshot').onclick = async () => {
  try { const blob = await captureFrame(video); addCapture(blob,'Photo',`courtline-photo-${fileStamp()}.jpg`); }
  catch (err) { status(`Photo not saved: ${err.message}`); }
};
function updateRecordingUI() {
  const on = !!sessionRecorder && sessionRecorder.state === 'recording';
  $('record').classList.toggle('recording', on);
  $('recordLabel').textContent = on ? 'Stop & save' : 'Record video';
  $('recordHint').textContent = on ? 'Recording now' : 'Save a full clip';
  $('record').querySelector('.capture-icon').textContent = on ? '■' : '●';
}
$('record').onclick = () => {
  if (sessionRecorder && sessionRecorder.state === 'recording') {
    sessionRecorder.stop(); sessionRecorder=null; updateRecordingUI(); return;
  }
  try {
    if (!currentStream || !currentStream.active) throw new Error('Start the stream first.');
    // A standalone start-to-stop file is more reliable on Safari than joining arbitrary time slices.
    sessionRecorder = createSessionRecorder(currentStream, blob => {
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      addCapture(blob,'Video',`courtline-video-${fileStamp()}.${ext}`);
    }, status);
    updateRecordingUI(); status('Recording. Tap Stop & save to finish the video.');
  } catch(err) { status(`Recording not started: ${err.message}`); }
};
$('save').onclick = () => {
  if(!chunks.length) return;
  const mime = recorder?.mimeType || recordingType || 'video/webm';
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks.map(c=>c.data),{type:mime});
  const name=`courtline-highlight-${fileStamp()}-${++clipNumber}.${ext}`;
  addCapture(blob, '30s highlight (experimental)', name);
  status('Highlight exported. If it will not play on iPhone, use Record video for a complete, compatible clip.');
};
(async function init(){ try {const me=await api('/me'); if(me.role){role=me.role;showApp();}} catch(err){console.error(err);} })();

async function uploadToCloud(blob, kind) {
  const mime = blob.type.split(';')[0] || (kind === 'Photo' ? 'image/jpeg' : 'video/mp4');
  const ticket = await api('/api/uploads', {method:'POST', body:JSON.stringify({type:mime,size:blob.size})});
  const response = await fetch(ticket.url, {method:'PUT',headers:{'Content-Type':ticket.content_type},body:blob});
  if(!response.ok) throw new Error(`R2 upload HTTP ${response.status}; verify bucket CORS`);
  status(`${kind} saved to the cloud ✓`);
  await loadCloud();
}
async function loadCloud() {
  try {
    const {items} = await api('/api/recordings');
    const gallery = $('cloudClips'); gallery.replaceChildren();
    if(!items.length) { const empty=document.createElement('div');empty.className='empty';empty.textContent='No cloud recordings yet.';gallery.appendChild(empty);return; }
    for(const item of items) {
      const card=document.createElement('article');card.className='capture-card';
      const preview=document.createElement('div');preview.className='capture-preview';
      const photo=/\.(jpg|png)$/i.test(item.key);
      const media=document.createElement(photo?'img':'video'); media.src=item.url;
      if(photo) media.alt='Tennis screenshot'; else {media.controls=true;media.playsInline=true;media.preload='metadata';}
      preview.appendChild(media);
      const meta=document.createElement('div');meta.className='capture-meta';
      const title=document.createElement('strong');title.textContent=photo?'Cloud photo':'Cloud video';
      const stamp=document.createElement('small');stamp.textContent=new Date(item.date).toLocaleString();
      const link=document.createElement('a');link.href=item.url;link.target='_blank';link.rel='noopener';link.textContent='Open / save ↗';
      meta.append(title,stamp,link);card.append(preview,meta);gallery.appendChild(card);
    }
  } catch(err) { $('cloudClips').textContent=`Cloud library unavailable: ${err.message}`; }
}
$('refreshCloud').onclick = loadCloud;
