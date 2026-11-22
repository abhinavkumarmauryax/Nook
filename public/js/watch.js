/* WatchTogetherParty - Copyright (c) 2026 Abhi. Source-available, non-commercial licence. See LICENSE. */

const socket = io();
const params = new URLSearchParams(location.search);
const pendingHostToken = params.get('host');
if (pendingHostToken) sessionStorage.setItem('wt_pending_host_token', pendingHostToken);
const pendingToken = sessionStorage.getItem('wt_pending_host_token') || undefined;

const username = sessionStorage.getItem('wt_username');
if (!username) { location.href = '/join'; }

const hostBadge = document.getElementById('hostBadge');
const adminBadge = document.getElementById('adminBadge');
const video = document.getElementById('video');
const videoWrapper = document.getElementById('videoWrapper');
const mainLayout = document.getElementById('mainLayout');
const chatSection = document.getElementById('chatSection');
const resizeHandle = document.getElementById('resizeHandle');
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
const videoUrlBtn = document.getElementById('videoUrlBtn');
const hostFileInput = document.getElementById('hostFileInput');
const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const usersEl = document.getElementById('users');
const onlineCount = document.getElementById('onlineCount');
const toastEl = document.getElementById('toast');
const leaveBtn = document.getElementById('leaveBtn');
const toggleChatBtn = document.getElementById('toggleChatBtn');

let myIsHost = false;
let myRole = 'member';
let mySocketId = null;
let myUsername = username;
let mySessionToken = sessionStorage.getItem('wt_session_token') || '';
let myOwnerToken = sessionStorage.getItem('wt_owner_token') || '';
let applying = false;
let correcting = false;
let seeking = false;
let pendingTime = null;
let authoritative = { isPlaying: false, currentTime: 0, timestamp: Date.now() };
let currentVideoKey = null;
let currentVideoDescriptor = null;
let loadTimeout = null;
let hls = null;
let raf = null;

function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
function setConn(msg) { document.getElementById('connStatus').textContent = msg; }
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('show'), 2500);
}
function roleLabel(role) {
  return role === 'owner' ? 'OWNER' : role === 'admin' ? 'ADMIN' : 'MEMBER';
}

// Chat rendering -----------------------------------------------------------
function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
}
function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function appendMessage(msg) {
  const stick = isNearBottom();
  const div = document.createElement('div');
  div.className = 'message ' + msg.type;
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (msg.type === 'system') {
    div.innerHTML = `<div class="bubble">${escapeHtml(msg.text)}</div><div class="meta">${time}</div>`;
  } else {
    if (msg.username === myUsername) div.classList.add('me');
    div.innerHTML = `<span class="username">${escapeHtml(msg.username)}:</span> <span class="bubble">${escapeHtml(msg.text)}</span><div class="meta">${time}</div>`;
  }
  messagesEl.appendChild(div);
  if (stick) scrollToBottom();
}

// Permissions / participants ----------------------------------------------
function setControlsEnabled() {
  playPauseBtn.style.display = myIsHost ? '' : 'none';
  seekRange.disabled = !myIsHost;
  muteBtn.disabled = false;
  volumeRange.disabled = false;
  fullscreenBtn.disabled = false;
  video.controls = false; // never expose native playback controls
}
function applyMyPermissions(data) {
  myRole = data.role || (data.isHost ? 'owner' : 'member');
  myIsHost = myRole === 'owner';
  hostBadge.style.display = myIsHost ? 'inline-block' : 'none';
  adminBadge.style.display = myRole === 'admin' ? 'inline-block' : 'none';
  setControlsEnabled();
  selectVideoBtn.style.display = myIsHost ? 'inline-flex' : 'none';
  videoUrlBtn.style.display = myIsHost ? 'inline-flex' : 'none';
  setMutedState(!!data.muted);
  renderUsers(lastUserList);
  enforcePlayback();
}
function setMutedState(muted) {
  messageInput.disabled = !!muted;
  sendBtn.disabled = !!muted;
  messageInput.placeholder = muted ? 'You are muted by the host' : 'Type a message…';
}
let lastUserList = [];
function renderUsers(list) {
  lastUserList = list || [];
  usersEl.innerHTML = '';
  onlineCount.textContent = lastUserList.length;
  lastUserList.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'role-' + u.role;
    const name = document.createElement('span');
    name.className = 'user-name';
    name.innerHTML = `<span class="dot"></span>${escapeHtml(u.username)}` +
      `<span class="role-tag role-tag-${u.role}">${roleLabel(u.role)}</span>` +
      (u.muted ? ' <span class="muted-tag">🔇 muted</span>' : '');
    li.appendChild(name);

    const canModerateHere = u.role !== 'owner' &&
      (myRole === 'owner' || (myRole === 'admin' && u.role === 'member'));
    if (canModerateHere) {
      li.appendChild(actionButton('mute', u.muted ? 'Unmute' : 'Mute', u.id));
      li.appendChild(actionButton('kick', 'Kick', u.id, 'danger'));
    }
    if (myRole === 'owner' && u.role !== 'owner') {
      li.appendChild(actionButton(u.role === 'admin' ? 'demote' : 'promote',
        u.role === 'admin' ? 'Demote' : 'Make admin', u.id));
      li.appendChild(actionButton('transfer', 'Transfer', u.id));
    }
    usersEl.appendChild(li);
  });
}
function actionButton(action, label, id, cls) {
  const b = document.createElement('button');
  b.className = 'user-action' + (cls ? ' ' + cls : '');
  b.dataset.action = action;
  b.dataset.id = id;
  b.textContent = label;
  return b;
}

usersEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const target = lastUserList.find((u) => u.id === btn.dataset.id);
  if (!target) return;
  const action = btn.dataset.action;

  if (action === 'kick') {
    const ok = await AppModal.confirm({
      title: 'Remove participant',
      message: `Remove ${target.username} from this session? They will be disconnected.`,
      confirmText: 'Kick', danger: true,
    });
    if (!ok) return;
  }
  if (action === 'transfer') {
    const ok = await AppModal.confirm({
      title: 'Transfer ownership',
      message: `Send ${target.username} a request to become the owner? You lose owner permissions only after they accept.`,
      confirmText: 'Send request',
    });
    if (!ok) return;
  }

  const eventMap = {
    mute: 'host:mute', kick: 'host:kick', promote: 'host:role', demote: 'host:role',
    transfer: 'host:transfer:request',
  };
  const payload = { targetId: btn.dataset.id };
  if (action === 'promote' || action === 'demote') payload.action = action;
  socket.emit(eventMap[action], payload, (resp) => {
    if (!resp || !resp.ok) showToast((resp && resp.message) || 'Action failed');
    else if (action === 'transfer') showToast(`Transfer request sent to ${target.username}`);
  });
});

// Video source -------------------------------------------------------------
function setTitle(name) {
  videoTitleEl.textContent = name || 'Watch Together';
  document.title = name ? `Watch Together — ${name}` : 'Watch Together';
}
function destroyHls() {
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
}
function showLoading(show) { loadingOverlay.style.display = show ? 'flex' : 'none'; }
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
function showNoVideo(msg) {
  if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
  showLoading(false);
  errorMsg.textContent = msg;
  document.getElementById('errorDiagRow').style.display = 'none';
  errorOverlay.style.display = 'flex';
  retryBtn.style.display = 'none';
}
function setVideoSrc(src, key, force = false) {
  if (!force && key && key === currentVideoKey && video.dataset.key === key) return;
  if (loadTimeout) clearTimeout(loadTimeout);
  currentVideoKey = key;
  video.dataset.key = key || '';
  video.src = src;
  video.load();
  video.controls = false;
  showLoading(true);
  errorOverlay.style.display = 'none';
  retryBtn.style.display = 'none';
  loadTimeout = setTimeout(() => {
    if (video.networkState === video.NETWORK_LOADING && video.readyState === 0) {
      showLoading(false);
      showVideoError('Video is taking too long to load. Check the source and try again.');
    }
  }, 30000);
}
function applyVideo(v) {
  currentVideoDescriptor = v || null;
  if (!v) {
    destroyHls();
    showNoVideo(myIsHost
      ? 'No video selected. Use 📁 Select Video or 🔗 Video URL to choose something to watch.'
      : 'The host has not selected a video yet. Sit tight — it will appear here automatically.');
    setTitle('Watch Together');
    return;
  }
  destroyHls();
  const isHls = v.kind === 'url' && /\.m3u8(\?|$)/i.test(v.url || '');
  if (isHls) {
    const native = !!video.canPlayType('application/vnd.apple.mpegurl');
    if (native) {
      setVideoSrc(v.url, v.key, true);
    } else if (window.Hls && Hls.isSupported()) {
      video.removeAttribute('src');
      video.load();
      currentVideoKey = v.key;
      video.dataset.key = v.key || '';
      hls = new Hls({ enableWorker: true });
      hls.loadSource(v.url);
      hls.attachMedia(video);
      showLoading(true);
      errorOverlay.style.display = 'none';
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        showLoading(false);
        if (authoritative.isPlaying) safePlay();
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data && data.fatal) showVideoError('The HLS stream could not be played.', `${data.type} / ${data.details || ''}`);
      });
    } else {
      showVideoError('HLS streams are not supported by this browser.');
    }
  } else {
    const src = v.kind === 'url' ? v.url : `/video?t=${encodeURIComponent(v.key)}&bust=${Date.now()}`;
    setVideoSrc(src, v.key, true);
  }
  setTitle(v.name);
}

// Playback state -----------------------------------------------------------
function expectedTime() {
  return authoritative.isPlaying
    ? Math.max(0, authoritative.currentTime + (Date.now() - authoritative.timestamp) / 1000)
    : authoritative.currentTime;
}
function safePlay() {
  try {
    const p = video.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err && err.name === 'NotAllowedError') showToast('Browser blocked autoplay — press play to start');
      });
    }
  } catch {}
}
function applyPlaybackState(state) {
  if (!state) return;
  authoritative = {
    isPlaying: !!state.isPlaying,
    currentTime: Number(state.currentTime) || 0,
    timestamp: Number(state.timestamp) || Date.now(),
  };
  applying = true;
  if (video.readyState > 0) {
    const t = Math.max(0, Math.min(expectedTime(), video.duration || Infinity));
    if (Math.abs(video.currentTime - t) > 0.3) { try { video.currentTime = t; } catch {} }
    if (authoritative.isPlaying) safePlay(); else video.pause();
  } else {
    pendingTime = Math.max(0, expectedTime());
  }
  updatePlayPauseIcon();
  applying = false;
}
function enforcePlayback() {
  if (myIsHost || applying || correcting || !currentVideoDescriptor) return;
  if (video.readyState === 0) return;
  const target = expectedTime();
  correcting = true;
  try {
    if (authoritative.isPlaying && video.paused) safePlay();
    else if (!authoritative.isPlaying && !video.paused) video.pause();
    if (Math.abs(video.currentTime - target) > 2) video.currentTime = Math.max(0, target);
  } catch {}
  correcting = false;
}
function updatePlayPauseIcon() { playPauseBtn.textContent = video.paused ? '▶' : '⏸'; }

video.addEventListener('loadedmetadata', () => {
  if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
  timeDisplay.textContent = `0:00 / ${formatTime(video.duration)}`;
  video.controls = false;
  showLoading(false);
  if (pendingTime !== null) { try { video.currentTime = pendingTime; } catch {} pendingTime = null; }
  enforcePlayback();
  if (myIsHost && isFinite(video.duration)) socket.emit('video:duration', { duration: video.duration });
});
video.addEventListener('loadeddata', () => showLoading(false));
video.addEventListener('canplay', () => showLoading(false));
video.addEventListener('error', () => {
  if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
  showLoading(false);
  const e = video.error;
  const names = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
  const code = e ? names[e.code] || `UNKNOWN(${e.code})` : 'NO_ERROR_OBJECT';
  const details = `Error: ${code}\nMessage: ${e ? e.message : 'unknown'}\nCan play MP4: "${video.canPlayType('video/mp4') || 'no'}"\nCan play WebM: "${video.canPlayType('video/webm') || 'no'}"\nSource: ${(currentVideoDescriptor && currentVideoDescriptor.kind === 'url') ? 'video URL' : 'host file'}`;
  showVideoError(`Unable to play video [${code}]`, details);
});

function tick() {
  if (!seeking && video.readyState > 0) {
    seekRange.max = video.duration || 100;
    seekRange.value = video.currentTime || 0;
    timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  }
  raf = requestAnimationFrame(tick);
}

video.addEventListener('play', () => {
  updatePlayPauseIcon();
  if (!raf) raf = requestAnimationFrame(tick);
  if (myIsHost && !applying && !correcting)
    socket.emit('playback:control', { action: 'play', time: video.currentTime });
  else if (!myIsHost && !applying && !correcting) enforcePlayback();
});
video.addEventListener('pause', () => {
  updatePlayPauseIcon();
  if (myIsHost && !applying && !correcting)
    socket.emit('playback:control', { action: 'pause', time: video.currentTime });
  else if (!myIsHost && !applying && !correcting) enforcePlayback();
});
video.addEventListener('seeking', () => { seeking = true; });
video.addEventListener('seeked', () => {
  seeking = false;
  if (myIsHost && !applying && !correcting)
    socket.emit('playback:control', { action: 'seek', time: video.currentTime });
  else if (!myIsHost && !applying && !correcting) enforcePlayback();
});
video.addEventListener('ratechange', () => { if (!myIsHost && !applying && !correcting) enforcePlayback(); });
video.addEventListener('ended', () => { updatePlayPauseIcon(); if (raf) cancelAnimationFrame(raf); raf = null; });
video.addEventListener('click', (e) => {
  if (!myIsHost) { e.preventDefault(); enforcePlayback(); }
});
video.addEventListener('contextmenu', (e) => { e.preventDefault(); });
setInterval(() => { if (!myIsHost) enforcePlayback(); }, 1000);

// Keyboard shortcuts that could change playback are blocked for non-owners.
document.addEventListener('keydown', (e) => {
  if (myIsHost) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const blocked = [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End',
    'PageUp', 'PageDown', 'k', 'K', 'j', 'J', 'l', 'L'];
  if (blocked.includes(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    enforcePlayback();
  }
}, true);

playPauseBtn.addEventListener('click', () => {
  if (!myIsHost) { showToast('Only the owner controls playback'); return; }
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
  if (!myIsHost) {
    seekRange.value = video.currentTime || 0;
    showToast('Only the owner can seek');
    return;
  }
  video.currentTime = seekRange.valueAsNumber;
});
fullscreenBtn.addEventListener('click', () => {
  const el = videoWrapper;
  if (el.requestFullscreen) el.requestFullscreen();
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
});

// Video URL ----------------------------------------------------------------
function verifyMediaUrl(url) {
  return new Promise((resolve) => {
    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && window.Hls && Hls.isSupported()) {
      const probe = new Hls({ enableWorker: true });
      let done = false;
      const finish = (ok, error) => { if (done) return; done = true; try { probe.destroy(); } catch {} resolve({ ok, error }); };
      probe.on(Hls.Events.MANIFEST_PARSED, () => finish(true));
      probe.on(Hls.Events.ERROR, (_e, d) => { if (d && d.fatal) finish(false, 'The HLS manifest could not be loaded.'); });
      probe.loadSource(url);
      setTimeout(() => finish(false, 'Timed out while checking the HLS stream.'), 12000);
      return;
    }
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      probe.removeAttribute('src');
      try { probe.load(); } catch {}
      resolve({ ok, error });
    };
    probe.onloadedmetadata = () => finish(true);
    probe.onerror = () => finish(false, 'This URL could not be loaded as a video. Use a direct MP4/WebM/HLS URL.');
    setTimeout(() => finish(false, 'Timed out while checking the URL.'), 12000);
    probe.src = url;
    probe.load();
  });
}
videoUrlBtn.addEventListener('click', async () => {
  const url = await AppModal.prompt({
    title: 'Stream a video URL',
    message: 'Paste a direct video URL (MP4, WebM, M4V or HLS .m3u8). Webpage links such as YouTube are not supported.',
    placeholder: 'https://example.com/video.mp4',
    confirmText: 'Verify and share',
  });
  if (!url) return;
  let parsed;
  try { parsed = new URL(url); } catch { return showToast('Enter a valid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) return showToast('Only HTTP and HTTPS URLs are supported');
  showToast('Checking the URL…');
  const result = await verifyMediaUrl(parsed.toString());
  if (!result.ok) { await AppModal.alert({ title: 'Could not use this URL', message: result.error || 'Unsupported media.' }); return; }
  socket.emit('video:url', { url: parsed.toString() }, (resp) => {
    if (!resp || !resp.ok) showToast((resp && resp.message) || 'Could not share the URL');
    else showToast('Video URL shared with everyone');
  });
});

selectVideoBtn.addEventListener('click', () => hostFileInput.click());
hostFileInput.addEventListener('change', () => {
  const file = hostFileInput.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024 * 1024) return showToast('File too large (max 2 GB)');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/video/upload', true);
  xhr.setRequestHeader('X-Host-Token', pendingToken || '');
  if (myOwnerToken) xhr.setRequestHeader('X-Owner-Token', myOwnerToken);
  xhr.setRequestHeader('X-File-Name', file.name);
  xhr.onload = () => {
    hostFileInput.value = '';
    if (xhr.status >= 200 && xhr.status < 300) showToast('Video selected for everyone');
    else { try { showToast(JSON.parse(xhr.responseText).error || 'Upload failed'); } catch { showToast('Upload failed'); } }
  };
  xhr.onerror = () => showToast('Upload failed (network error)');
  xhr.send(file);
});

// Chat ---------------------------------------------------------------------
sendBtn.addEventListener('click', () => {
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit('chat:message', { text }, (resp) => {
    if (!resp || !resp.ok) return showToast((resp && resp.message) || 'Send failed');
    messageInput.value = '';
  });
});
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendBtn.click(); }
});

// Chat panel: hide/show and resize -----------------------------------------
function setChatHidden(hidden) {
  mainLayout.classList.toggle('chat-collapsed', hidden);
  toggleChatBtn.textContent = hidden ? '💬 Show Chat' : '💬 Hide Chat';
  toggleChatBtn.setAttribute('aria-expanded', String(!hidden));
  localStorage.setItem('wt_chat_hidden', hidden ? '1' : '0');
}
toggleChatBtn.addEventListener('click', () => setChatHidden(!mainLayout.classList.contains('chat-collapsed')));
setChatHidden(localStorage.getItem('wt_chat_hidden') === '1');

const CHAT_MIN = 280, CHAT_MAX = 620, VIDEO_MIN = 360;
try {
  const savedWidth = parseInt(localStorage.getItem('wt_chat_width') || '', 10);
  if (savedWidth >= CHAT_MIN && savedWidth <= CHAT_MAX) mainLayout.style.setProperty('--chat-width', savedWidth + 'px');
} catch {}
let resizing = false;
resizeHandle.addEventListener('pointerdown', (e) => {
  if (window.innerWidth <= 900 || mainLayout.classList.contains('chat-collapsed')) return;
  resizing = true;
  document.body.classList.add('is-resizing');
  try { resizeHandle.setPointerCapture(e.pointerId); } catch {}
});
window.addEventListener('pointermove', (e) => {
  if (!resizing) return;
  const rect = mainLayout.getBoundingClientRect();
  let width = rect.right - e.clientX;
  width = Math.max(CHAT_MIN, Math.min(CHAT_MAX, width, rect.width - VIDEO_MIN - 8));
  mainLayout.style.setProperty('--chat-width', width + 'px');
});
window.addEventListener('pointerup', () => {
  if (!resizing) return;
  resizing = false;
  document.body.classList.remove('is-resizing');
  const w = parseInt(getComputedStyle(mainLayout).getPropertyValue('--chat-width'), 10);
  if (w >= CHAT_MIN && w <= CHAT_MAX) localStorage.setItem('wt_chat_width', String(w));
});

function openPopout() {
  if (!mySessionToken) { showToast('Reconnecting — try again in a moment'); return; }
  const url = `${location.origin}/chat#${encodeURIComponent(mySessionToken)}`;
  window.open(url, 'watch_together_chat', 'width=430,height=760');
}
document.getElementById('popoutBtn').addEventListener('click', openPopout);
document.getElementById('popoutBtnTop').addEventListener('click', openPopout);

// Participants toggle ------------------------------------------------------
const toggleUsersBtn = document.getElementById('toggleUsersBtn');
toggleUsersBtn.addEventListener('click', () => {
  const list = document.getElementById('users');
  const show = list.style.display === 'none';
  list.style.display = show ? '' : 'none';
  toggleUsersBtn.setAttribute('aria-expanded', String(show));
  toggleUsersBtn.textContent = show ? 'Participants ▾' : 'Participants ▸';
});

// Retry --------------------------------------------------------------------
const retryBtn = document.getElementById('retryBtn');
retryBtn.addEventListener('click', () => {
  if (!currentVideoDescriptor) return;
  applyVideo(currentVideoDescriptor);
});

// Connection ---------------------------------------------------------------
function joinSession() {
  socket.emit('join:request', {
    username: myUsername,
    hostToken: pendingToken,
    sessionToken: mySessionToken || undefined,
  }, (resp) => {
    if (!resp || !resp.ok) {
      sessionStorage.setItem('wt_join_error', (resp && resp.message) || 'Could not join the session');
      sessionStorage.removeItem('wt_username');
      location.href = '/join';
    }
  });
}
socket.on('connect', () => { setConn('● Connected'); joinSession(); });
socket.on('disconnect', () => setConn('○ Disconnected'));
socket.on('connect_error', () => setConn('⚠ Connection error'));

socket.on('joined', (resp) => {
  mySocketId = resp.socketId;
  mySessionToken = resp.sessionToken || mySessionToken;
  if (mySessionToken) sessionStorage.setItem('wt_session_token', mySessionToken);
  myOwnerToken = resp.ownerToken || '';
  if (myOwnerToken) sessionStorage.setItem('wt_owner_token', myOwnerToken);
  else sessionStorage.removeItem('wt_owner_token');
  applyMyPermissions({ role: resp.role, isHost: resp.isHost, muted: (resp.users || []).find((u) => u.id === resp.userId)?.muted });
  renderUsers(resp.users);
  (resp.messages || []).forEach(appendMessage);
  scrollToBottom();
  applyPlaybackState(resp.playback);
  applyVideo(resp.video);
});

socket.on('permissions:updated', (data) => {
  if (data.username !== myUsername) return;
  myOwnerToken = data.ownerToken || '';
  if (myOwnerToken) sessionStorage.setItem('wt_owner_token', myOwnerToken);
  else sessionStorage.removeItem('wt_owner_token');
  applyMyPermissions(data);
});
socket.on('users:updated', (data) => renderUsers(data.users));
socket.on('user:joined', (data) => renderUsers(data.users));
socket.on('user:left', (data) => renderUsers(data.users));
socket.on('chat:message', (msg) => appendMessage(msg));

socket.on('user:replaced', (data) => {
  showToast(data.message || 'This session was replaced by another tab.');
  location.href = '/join';
});
socket.on('user:kicked', (data) => {
  sessionStorage.removeItem('wt_username');
  sessionStorage.removeItem('wt_session_token');
  sessionStorage.removeItem('wt_owner_token');
  AppModal.alert({ title: 'Removed from session', message: data.message || 'You were removed by a moderator.' })
    .then(() => { location.href = '/join'; });
});
socket.on('user:muted', (data) => {
  setMutedState(data.muted);
  showToast(data.muted ? 'You have been muted' : 'You have been unmuted');
});
socket.on('host:transfer:offer', async (data) => {
  const accept = await AppModal.confirm({
    title: 'Ownership transfer request',
    message: `${data.from} wants to transfer ownership of this session to you. Accept?`,
    confirmText: 'Accept', cancelText: 'Reject',
  });
  socket.emit('host:transfer:respond', { id: data.id, accept }, (resp) => {
    if (!resp || !resp.ok) showToast((resp && resp.message) || 'Could not respond to the transfer');
  });
});
socket.on('host:transfer:declined', (data) => {
  showToast(`${data.by || 'The participant'} declined or became unavailable — ownership is unchanged.`);
});
socket.on('host:transfer:complete', (data) => {
  showToast(`${data.newOwner} is now the owner`);
  renderUsers(data.users);
});

socket.on('video:changed', ({ video: v, system }) => {
  applyVideo(v);
  if (system) showToast(system);
});
socket.on('playback:state', applyPlaybackState);
socket.on('playback:control', (data) => {
  if (data.originator === mySocketId) return;
  authoritative = {
    isPlaying: !!data.isPlaying,
    currentTime: Number(data.time) || 0,
    timestamp: Number(data.timestamp) || Date.now(),
  };
  applyPlaybackState({ ...authoritative, timestamp: data.timestamp });
});

// init
setControlsEnabled();
if (!video.canPlayType('video/mp4') && !video.canPlayType('video/webm')) {
  showToast('Warning: this browser may not support common video formats');
}
