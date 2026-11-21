const socket = io();
const params = new URLSearchParams(location.search);
const pendingHostToken = params.get('host');
if (pendingHostToken) sessionStorage.setItem('wt_pending_host_token', pendingHostToken);

const username = sessionStorage.getItem('wt_username');
if (!username) { location.href = '/join'; }

const hostBadge = document.getElementById('hostBadge');
const video = document.getElementById('video');
const loadingOverlay = document.getElementById('loadingOverlay');
const errorOverlay = document.getElementById('errorOverlay');
const errorMsg = document.getElementById('errorMsg');
const playPauseBtn = document.getElementById('playPauseBtn');
const muteBtn = document.getElementById('muteBtn');
const volumeRange = document.getElementById('volumeRange');
const seekRange = document.getElementById('seekRange');
const timeDisplay = document.getElementById('timeDisplay');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const videoTitleEl = document.getElementById('videoTitle');
const selectVideoBtn = document.getElementById('selectVideoBtn');
const hostFileInput = document.getElementById('hostFileInput');
const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const usersEl = document.getElementById('users');
const onlineCount = document.getElementById('onlineCount');
const toastEl = document.getElementById('toast');
const leaveBtn = document.getElementById('leaveBtn');

let myIsHost = false;
let mySocketId = null;
let myUsername = username;
let applying = false;
let seeking = false;
let pendingTime = null;
let pendingPlayback = null;
let currentVideoKey = null;

function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function setConn(msg) {
  const el = document.getElementById('connStatus');
  el.textContent = msg;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2500);
}

function setControlsEnabled(isHost) {
  // Playback and seeking stay host-only. Volume and fullscreen are personal
  // settings, so everyone gets them. Viewers don't need a play/pause button.
  playPauseBtn.style.display = isHost ? '' : 'none';
  seekRange.disabled = !isHost;
  muteBtn.disabled = false;
  volumeRange.disabled = false;
  fullscreenBtn.disabled = false;
  if (!isHost) playPauseBtn.textContent = '▶';
}

function renderUsers(list) {
  usersEl.innerHTML = '';
  onlineCount.textContent = (list || []).length;
  (list || []).forEach((u) => {
    const li = document.createElement('li');
    if (u.isHost) li.classList.add('host');

    const name = document.createElement('span');
    name.className = 'user-name';
    name.innerHTML = `<span class="dot"></span>${escapeHtml(u.username)}` +
      (u.isHost ? ' <span class="host-tag">(host)</span>' : '') +
      (u.muted ? ' <span class="muted-tag">🔇 muted</span>' : '');
    li.appendChild(name);

    if (myIsHost && !u.isHost) {
      const mute = document.createElement('button');
      mute.className = 'user-action';
      mute.dataset.action = 'mute';
      mute.dataset.id = u.id;
      mute.textContent = u.muted ? 'Unmute' : 'Mute';
      const kick = document.createElement('button');
      kick.className = 'user-action danger';
      kick.dataset.action = 'kick';
      kick.dataset.id = u.id;
      kick.textContent = 'Kick';
      li.append(mute, kick);
    }
    usersEl.appendChild(li);
  });
}

function setMutedState(muted) {
  messageInput.disabled = !!muted;
  sendBtn.disabled = !!muted;
  messageInput.placeholder = muted ? 'You are muted by the host' : 'Type a message…';
}

usersEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || !myIsHost) return;
  const event = btn.dataset.action === 'kick' ? 'host:kick' : 'host:mute';
  socket.emit(event, { targetId: btn.dataset.id }, (resp) => {
    if (!resp || !resp.ok) showToast((resp && resp.message) || 'Action failed');
  });
});

// Must be checked BEFORE adding a new message: after appending, scrollHeight
// has already grown, so a tall message would look like the user scrolled up.
function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendMessage(msg) {
  const stickToBottom = isNearBottom();
  const div = document.createElement('div');
  div.className = 'message ' + msg.type;
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (msg.type === 'system') {
    div.innerHTML = `<div class="bubble">${escapeHtml(msg.text)}</div><div class="meta">${time}</div>`;
  } else {
    const mine = msg.username === myUsername;
    if (mine) div.classList.add('me');
    div.innerHTML = `<span class="username">${escapeHtml(msg.username)}:</span> <span class="bubble">${escapeHtml(msg.text)}</span><div class="meta">${time}</div>`;
  }
  messagesEl.appendChild(div);
  if (stickToBottom) scrollToBottom();
}

function showLoading(show) {
  loadingOverlay.style.display = show ? 'flex' : 'none';
}

function showVideoError(msg, details) {
  errorMsg.textContent = msg;
  if (details) {
    const diag = document.getElementById('errorDiag');
    if (diag) diag.textContent = details;
    document.getElementById('errorDiagRow').style.display = 'block';
  }
  errorOverlay.style.display = 'flex';
  showLoading(false);
  retryBtn.style.display = 'inline-block';
}

let loadTimeout;
function setVideoSrc(src, key, force = false) {
  // The server emits both "joined" and "video:changed" on connect. Ignore the
  // duplicate so we never abort a load that is already in progress.
  if (!force && key && key === currentVideoKey && video.dataset.key === key) return;
  if (loadTimeout) clearTimeout(loadTimeout);
  currentVideoKey = key;
  video.dataset.key = key || '';
  video.src = src;
  video.load();
  showLoading(true);
  errorOverlay.style.display = 'none';
  retryBtn.style.display = 'none';
  loadTimeout = setTimeout(() => {
    if (video.networkState === video.NETWORK_LOADING && video.readyState === 0) {
      showLoading(false);
      showVideoError('Video is taking too long to load (30s timeout). Large files may need more time. Click Retry or try a smaller file.');
    }
  }, 30000);
}

function showNoVideo(msg) {
  if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
  showLoading(false);
  errorMsg.textContent = msg || 'No video selected yet. Use the 📁 Select Video button below to choose one.';
  const diag = document.getElementById('errorDiagRow');
  if (diag) diag.style.display = 'none';
  errorOverlay.style.display = 'flex';
  retryBtn.style.display = 'none';
}

function safePlay() {
  try {
    const p = video.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err && err.name === 'NotAllowedError') {
          showToast('Browser blocked autoplay — press ▶ to start');
        }
      });
    }
  } catch {}
}

function applyPlaybackState(state) {
  if (!state) return;
  pendingPlayback = state;
  applying = true;
  if (video.readyState > 0) {
    video.currentTime = Math.max(0, Math.min(state.currentTime || 0, video.duration || 0));
    if (state.isPlaying) safePlay();
    else video.pause();
  } else {
    pendingTime = Math.max(0, state.currentTime || 0);
  }
  updatePlayPauseIcon();
  applying = false;
}

// ---------------- connection ----------------
const pendingToken = sessionStorage.getItem('wt_pending_host_token') || undefined;

// Join the session on every (re)connect. The server also emits "joined", which
// is handled below and is the single place that renders the session state.
function joinSession() {
  socket.emit('join:request', { username: myUsername, hostToken: pendingToken }, (resp) => {
    if (!resp || !resp.ok) {
      const msg = (resp && resp.message) || 'Could not join the session';
      sessionStorage.setItem('wt_join_error', msg);
      sessionStorage.removeItem('wt_username');
      location.href = '/join';
    }
  });
}

socket.on('connect', () => { setConn('● Connected'); joinSession(); });
socket.on('disconnect', () => setConn('○ Disconnected'));
socket.on('connect_error', () => setConn('⚠ Connection error'));

socket.on('joined', (resp) => {
  myIsHost = resp.isHost;
  mySocketId = resp.socketId;
  hostBadge.style.display = myIsHost ? 'inline-block' : 'none';
  setControlsEnabled(myIsHost);
  if (myIsHost) selectVideoBtn.style.display = 'inline-flex';
  const me = (resp.users || []).find((u) => u.id === mySocketId);
  setMutedState(me ? me.muted : false);
  renderUsers(resp.users);
  (resp.messages || []).forEach(appendMessage);
  scrollToBottom();
  applyPlaybackState(resp.playback);
  if (resp.videoKey) {
    setVideoSrc(`/video?t=${encodeURIComponent(resp.videoKey)}&bust=${Date.now()}`, resp.videoKey);
    if (resp.video) {
      videoTitleEl.textContent = resp.video.name || 'Watch Together';
      document.title = resp.video.name ? `Watch Together — ${resp.video.name}` : 'Watch Together';
    }
  } else {
    showNoVideo(myIsHost
      ? 'No video selected yet. Use the 📁 Select Video button below to choose one.'
      : 'The host has not selected a video yet. Sit tight — it will appear here automatically.');
  }
});

socket.on('user:replaced', (data) => {
  showToast(data.message || 'Your session was replaced by another connection.');
  location.href = '/join';
});

socket.on('user:kicked', (data) => {
  sessionStorage.removeItem('wt_username');
  showToast(data.message || 'You were removed from the session by the host.');
  setTimeout(() => { location.href = '/join'; }, 1500);
});

socket.on('user:muted', (data) => {
  setMutedState(data.muted);
  showToast(data.muted ? 'You have been muted by the host' : 'The host unmuted you');
});

// Join/leave system messages come from the server as regular chat:message
// events, so these handlers only refresh the participant list.
socket.on('user:joined', (data) => renderUsers(data.users));
socket.on('user:left', (data) => renderUsers(data.users));
socket.on('users:updated', (data) => renderUsers(data.users));

socket.on('chat:message', (msg) => appendMessage(msg));

socket.on('video:changed', ({ video: v }) => {
  setVideoSrc(`/video?t=${encodeURIComponent(v.key)}&bust=${Date.now()}`, v.key);
  videoTitleEl.textContent = v.name || 'Watch Together';
  document.title = v.name ? `Watch Together — ${v.name}` : 'Watch Together';
  showToast('New video selected: ' + escapeHtml(v.name));
  applying = true;
  video.pause();
  applying = false;
  pendingPlayback = null;
});

socket.on('playback:state', applyPlaybackState);

socket.on('playback:control', (data) => {
  if (data.originator === mySocketId) return;
  applying = true;
  if (video.readyState > 0) video.currentTime = Math.max(0, data.time || 0);
  else pendingTime = Math.max(0, data.time || 0);
  if (data.isPlaying) safePlay();
  else video.pause();
  updatePlayPauseIcon();
  applying = false;
});

// ---------------- video element ----------------
video.addEventListener('loadedmetadata', () => {
  if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
  timeDisplay.textContent = `0:00 / ${formatTime(video.duration)}`;
  showLoading(false);
  if (pendingTime !== null) { try { video.currentTime = pendingTime; } catch {} pendingTime = null; }
  if (pendingPlayback && video.readyState > 0) {
    if (pendingPlayback.isPlaying) safePlay();
    else video.pause();
    pendingPlayback = null;
  }
  if (myIsHost && isFinite(video.duration)) socket.emit('video:duration', { duration: video.duration });
});

video.addEventListener('loadeddata', () => { showLoading(false); });
video.addEventListener('canplay', () => { showLoading(false); });
video.addEventListener('error', () => {
  if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
  showLoading(false);
  const e = video.error;
  const errorCodes = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
  const codeName = e ? errorCodes[e.code] || `UNKNOWN(${e.code})` : 'NO_ERROR_OBJECT';

  // Build detailed diagnostics
  const canPlayMp4 = video.canPlayType('video/mp4');
  const canPlayWebm = video.canPlayType('video/webm');
  const details =
    `Error: ${codeName}\n` +
    `Message: ${e ? e.message : 'unknown'}\n` +
    `Network state: ${video.networkState} (0=EMPTY,1=IDLE,2=LOADING,3=NO_SOURCE)\n` +
    `Ready state: ${video.readyState} (0=HAVE_NOTHING,1=HAVE_METADATA,2=HAVE_CURRENT_DATA,3=HAVE_FUTURE_DATA,4=HAVE_ENOUGH_DATA)\n` +
    `Can play MP4: "${canPlayMp4 || 'no'}"\n` +
    `Can play WebM: "${canPlayWebm || 'no'}"\n` +
    `Src: ${video.src}\n` +
    `Duration: ${video.duration}\n` +
    `Buffered: ${video.buffered.length} range(s)`;

  const msg = e ? `Video error [${codeName}]: ${e.message}` : 'Unable to play video';
  showVideoError(msg, details);
  console.error('Video error details:', { code: e?.code, message: e?.message, networkState: video.networkState, readyState: video.readyState, src: video.src });
});

let raf;
function tick() {
  if (!seeking && video.readyState > 0) {
    seekRange.max = video.duration || 100;
    seekRange.value = video.currentTime || 0;
    timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  }
  raf = requestAnimationFrame(tick);
}

function updatePlayPauseIcon() {
  playPauseBtn.textContent = video.paused ? '▶' : '⏸';
}

video.addEventListener('play', () => {
  updatePlayPauseIcon();
  if (!raf) raf = requestAnimationFrame(tick);
  if (myIsHost && !applying) socket.emit('playback:control', { action: 'play', time: video.currentTime });
});
video.addEventListener('pause', () => {
  updatePlayPauseIcon();
  if (myIsHost && !applying) socket.emit('playback:control', { action: 'pause', time: video.currentTime });
});
video.addEventListener('seeking', () => { seeking = true; });
video.addEventListener('seeked', () => {
  seeking = false;
  if (myIsHost && !applying) socket.emit('playback:control', { action: 'seek', time: video.currentTime });
});
video.addEventListener('ended', () => { updatePlayPauseIcon(); cancelAnimationFrame(raf); raf = null; });

playPauseBtn.addEventListener('click', () => {
  if (!myIsHost) return showToast('Only the host controls playback');
  if (video.paused) video.play().catch(() => showToast('Unable to play video'));
  else video.pause();
});

muteBtn.addEventListener('click', () => {
  video.muted = !video.muted;
  muteBtn.textContent = video.muted ? '🔇' : '🔊';
});
volumeRange.addEventListener('input', () => { video.volume = volumeRange.value; });

seekRange.addEventListener('mousedown', () => { seeking = true; });
seekRange.addEventListener('mouseup', () => { seeking = false; });
seekRange.addEventListener('touchstart', () => { seeking = true; });
seekRange.addEventListener('touchend', () => { seeking = false; });
seekRange.addEventListener('input', () => {
  timeDisplay.textContent = `${formatTime(seekRange.valueAsNumber)} / ${formatTime(video.duration)}`;
});
seekRange.addEventListener('change', () => {
  if (!myIsHost) { seekRange.value = video.currentTime || 0; return showToast('Only the host controls playback'); }
  video.currentTime = seekRange.valueAsNumber;
});

fullscreenBtn.addEventListener('click', () => {
  if (video.requestFullscreen) video.requestFullscreen();
  else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
});

// ---------------- host video select ----------------
selectVideoBtn.addEventListener('click', () => hostFileInput.click());

hostFileInput.addEventListener('change', () => {
  const file = hostFileInput.files[0];
  if (!file) return;
  const maxGB = 2;
  if (file.size > maxGB * 1024 * 1024 * 1024) return showToast(`File too large (max ${maxGB} GB)`);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/video/upload', true);
  xhr.setRequestHeader('X-Host-Token', pendingToken);
  xhr.setRequestHeader('X-File-Name', file.name);
  xhr.upload.onprogress = () => {};
  xhr.onload = () => {
    hostFileInput.value = '';
    if (xhr.status >= 200 && xhr.status < 300) {
      showToast('Video selected for everyone');
    } else {
      try { showToast(JSON.parse(xhr.responseText).error || 'Upload failed'); } catch { showToast('Upload failed'); }
    }
  };
  xhr.onerror = () => showToast('Upload failed (network error)');
  xhr.send(file);
});

// ---------------- chat ----------------
sendBtn.addEventListener('click', () => {
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit('chat:message', { text }, (resp) => {
    if (!resp || !resp.ok) return showToast(resp.message || 'Send failed');
    messageInput.value = '';
  });
});
messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendBtn.click(); } });

// ---------------- participants panel ----------------
const toggleUsersBtn = document.getElementById('toggleUsersBtn');
if (toggleUsersBtn) toggleUsersBtn.addEventListener('click', () => {
  const list = document.getElementById('users');
  const show = list.style.display === 'none';
  list.style.display = show ? '' : 'none';
  toggleUsersBtn.setAttribute('aria-expanded', String(show));
  toggleUsersBtn.textContent = show ? 'Participants ▾' : 'Participants ▸';
});

// ---------------- leave ----------------
leaveBtn.addEventListener('click', () => {
  socket.disconnect();
  location.href = '/join';
});

// init
setControlsEnabled(false);

// Video format diagnostics
const mp4Support = video.canPlayType('video/mp4');
const webmSupport = video.canPlayType('video/webm');
if (!mp4Support && !webmSupport) {
  showToast('Warning: Your browser may not support MP4 or WebM video playback');
}

// Debug panel
const debugPanel = document.createElement('div');
debugPanel.id = 'debugPanel';
debugPanel.style.cssText = 'position:fixed;bottom:0;right:0;width:300px;max-height:200px;background:rgba(0,0,0,0.85);color:#0f0;font-family:monospace;font-size:11px;padding:8px;overflow:auto;z-index:1000;display:none;border-top:1px solid #333;border-left:1px solid #333;';
debugPanel.innerHTML = '<div id="debugTitle">🔧 Video Debug</div><div id="debugContent"></div>';
document.body.appendChild(debugPanel);

let debugLog = [];
function debug(msg) {
  const now = new Date().toLocaleTimeString();
  debugLog.push(`[${now}] ${msg}`);
  if (debugLog.length > 15) debugLog.shift();
  document.getElementById('debugContent').textContent = debugLog.join('\n');
  console.log('[VIDEO DEBUG]', msg);
}

function toggleDebug() {
  debugPanel.style.display = debugPanel.style.display === 'none' ? 'block' : 'none';
}
window.toggleDebug = toggleDebug;

// Show debug on error
video.addEventListener('error', () => {
  toggleDebug();
  debug('ERROR event fired');
});

// Test video button - serves a small, real H.264 MP4 bundled with the app
const testVideoBtn = document.getElementById('testVideoBtn');
if (testVideoBtn) testVideoBtn.addEventListener('click', () => {
  debug('Test video button clicked');
  setVideoSrc('/sample-test.mp4', 'test-video', true);
  videoTitleEl.textContent = 'Test Video';
  document.title = 'Watch Together — Test Video';
  showToast('Loading test video...');
});

// Retry button
const retryBtn = document.getElementById('retryBtn');
retryBtn.addEventListener('click', () => {
  if (!currentVideoKey) return;
  const src = `/video?t=${encodeURIComponent(currentVideoKey)}&bust=${Date.now()}`;
  setVideoSrc(src, currentVideoKey, true);
});