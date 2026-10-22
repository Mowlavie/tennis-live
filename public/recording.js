// Local-only capture helpers. Files must be explicitly saved by the viewer.
const supportedRecordingType = () => {
  if (!window.MediaRecorder) return '';
  return ['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
};
function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  return url;
}
function captureFrame(video) {
  if (!video.videoWidth || !video.videoHeight) throw new Error('Wait for video to appear.');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Unable to capture the frame.')), 'image/jpeg', .92));
}
function createSessionRecorder(stream, onSaved, onError) {
  if (!window.MediaRecorder) throw new Error('This iOS version does not support video recording.');
  const mime = supportedRecordingType();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const parts = [];
  recorder.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
  recorder.onerror = () => onError('Recording interrupted.');
  recorder.onstop = () => {
    if (!parts.length) { onError('No video data was recorded.'); return; }
    onSaved(new Blob(parts, {type: recorder.mimeType || mime || 'video/mp4'}));
  };
  recorder.start(2000);
  return recorder;
}
