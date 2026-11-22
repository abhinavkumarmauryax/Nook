/* WatchTogetherParty - Copyright (c) 2026 Abhi. Source-available, non-commercial licence. See LICENSE. */

const portInput = document.getElementById('portInput');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const networkInfo = document.getElementById('networkInfo');
const urlDisplay = document.getElementById('urlDisplay');
const ipsDisplay = document.getElementById('ipsDisplay');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const chatUrlDisplay = document.getElementById('chatUrlDisplay');
const copyChatUrlBtn = document.getElementById('copyChatUrlBtn');
const participantCount = document.getElementById('participantCount');
const openWatchBtn = document.getElementById('openWatchBtn');
const videoInfo = document.getElementById('videoInfo');
const videoName = document.getElementById('videoName');
const videoSizeEl = document.getElementById('videoSize');

let sessionInfo = null;

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('status failed');
    sessionInfo = await res.json();
  } catch (e) {
    showError(errorEl, 'Cannot reach setup server');
    return;
  }
  render();
}

function render() {
  if (!sessionInfo) return;
  const running = !!sessionInfo.running;
  statusEl.textContent = running ? 'Running' : 'Stopped';
  statusEl.className = 'status ' + (running ? 'ok' : 'err');

  startBtn.disabled = running;
  stopBtn.disabled = !running;
  openWatchBtn.disabled = !running;

  showError(errorEl, sessionInfo.error || '');

  if (running) {
    networkInfo.style.display = 'block';
    urlDisplay.textContent = sessionInfo.url || '—';
    chatUrlDisplay.textContent = sessionInfo.url ? sessionInfo.url + '/chat' : '—';
    openWatchBtn.dataset.url = sessionInfo.url || '';
    openWatchBtn.dataset.token = sessionInfo.hostToken || '';
    ipsDisplay.textContent = (sessionInfo.ips && sessionInfo.ips.length ? sessionInfo.ips.join(', ') : '—');
    participantCount.textContent = sessionInfo.participants != null ? sessionInfo.participants : 0;
    if (sessionInfo.video) {
      videoInfo.style.display = 'block';
      videoName.textContent = sessionInfo.video.name;
      videoSizeEl.textContent = '(' + formatSize(sessionInfo.video.size) + ')';
    } else {
      videoInfo.style.display = 'none';
    }
  } else {
    networkInfo.style.display = 'none';
    videoInfo.style.display = 'none';
  }
}

startBtn.addEventListener('click', async () => {
  const port = portInput.value.trim();
  if (!port) return showError(errorEl, 'Enter a port number');
  showError(errorEl, '');
  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    const json = await res.json();
    if (!res.ok) return showError(errorEl, json.error || 'Failed to start server');
    await refresh();
  } catch (e) {
    showError(errorEl, 'Could not reach setup server');
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/stop', { method: 'POST' });
    await refresh();
  } catch (e) {
    showError(errorEl, 'Failed to stop server');
  }
});

copyUrlBtn.addEventListener('click', async () => {
  const url = urlDisplay.textContent;
  if (!url || url === '—') return;
  try {
    await navigator.clipboard.writeText(url);
    const prev = copyUrlBtn.textContent;
    copyUrlBtn.textContent = 'Copied!';
    setTimeout(() => { copyUrlBtn.textContent = prev; }, 1500);
  } catch {}
});

copyChatUrlBtn.addEventListener('click', async () => {
  const url = chatUrlDisplay.textContent;
  if (!url || url === '—') return;
  try {
    await navigator.clipboard.writeText(url);
    const prev = copyChatUrlBtn.textContent;
    copyChatUrlBtn.textContent = 'Copied!';
    setTimeout(() => { copyChatUrlBtn.textContent = prev; }, 1500);
  } catch {}
});

openWatchBtn.addEventListener('click', () => {
  const url = openWatchBtn.dataset.url;
  const token = openWatchBtn.dataset.token;
  if (!url) return showError(errorEl, 'Server is not running');
  window.open(`${url}/watch?host=${token || ''}`, '_blank');
});

setInterval(refresh, 2000);
refresh();

window.addEventListener('error', (e) => {
  showError(errorEl, 'JavaScript error: ' + (e.message || 'Unknown error'));
});
