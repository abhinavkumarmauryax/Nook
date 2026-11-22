/* Nook - Copyright (c) 2026 Abhi. Source-available, non-commercial licence. See LICENSE. */

/* Standalone pop-out chat. Authenticates with the session token from the URL fragment. */
if (window.applyIcons) applyIcons();
const socket = io();
const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const usersEl = document.getElementById('users');
const onlineCount = document.getElementById('onlineCount');
const toastEl = document.getElementById('toast');
const token = decodeURIComponent((location.hash || '').replace(/^#/, ''));

let myUsername = '';
let myRole = 'member';
let myIsHost = false;
let lastUserList = [];

function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('show'), 2500);
}
function roleLabel(role) { return role === 'owner' ? 'OWNER' : role === 'admin' ? 'ADMIN' : 'MEMBER'; }
function deny(message) {
  document.getElementById('chatBody').style.display = 'none';
  document.getElementById('denied').style.display = 'flex';
  if (message) document.getElementById('deniedMessage').textContent = message;
}

if (!token) deny();
else {
  socket.on('connect', () => {
    socket.emit('chat:auth', { token }, (resp) => {
      if (!resp || !resp.ok) {
        deny((resp && resp.message) || 'This session has ended. Join the session again.');
        return;
      }
      myUsername = resp.username;
      applyPermissions(resp.role, resp.muted);
      renderUsers(resp.users);
      (resp.messages || []).forEach(appendMessage);
      scrollToBottom();
      messageInput.disabled = false;
      sendBtn.disabled = false;
      messageInput.focus();
    });
  });
}

function applyPermissions(role, muted) {
  myRole = role || 'member';
  myIsHost = myRole === 'owner';
  const label = document.getElementById('myRole');
  label.textContent = roleLabel(myRole);
  label.className = 'role-tag role-tag-' + myRole;
  if (typeof muted === 'boolean') setMutedState(muted);
  renderUsers(lastUserList);
}
function setMutedState(muted) {
  messageInput.disabled = !!muted;
  sendBtn.disabled = !!muted;
  messageInput.placeholder = muted ? 'You are muted by the host' : 'Type a message…';
}

function actionButton(action, label, id, cls) {
  const b = document.createElement('button');
  b.className = 'user-action' + (cls ? ' ' + cls : '');
  b.dataset.action = action;
  b.dataset.id = id;
  b.textContent = label;
  return b;
}
function renderUsers(list) {
  lastUserList = list || [];
  usersEl.innerHTML = '';
  onlineCount.textContent = lastUserList.length;
  lastUserList.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'role-' + u.role;
    const av = document.createElement('span');
    av.className = 'avatar avatar-' + u.role;
    av.textContent = String(u.username || '?').trim().split(/[\s_.\-]+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('') || '?';
    li.appendChild(av);
    const name = document.createElement('span');
    name.className = 'user-name';
    name.innerHTML = `${escapeHtml(u.username)}` +
      `<span class="role-tag role-tag-${u.role}">${roleLabel(u.role)}</span>` +
      (u.muted ? ' <span class="muted-tag">🔇 muted</span>' : '');
    li.appendChild(name);
    const canModerate = u.role !== 'owner' &&
      (myRole === 'owner' || (myRole === 'admin' && u.role === 'member'));
    if (canModerate) {
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

usersEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const target = lastUserList.find((u) => u.id === btn.dataset.id);
  if (!target) return;
  if (btn.dataset.action === 'kick') {
    const ok = await AppModal.confirm({
      title: 'Remove participant',
      message: `Remove ${target.username} from this session?`,
      confirmText: 'Kick', danger: true,
    });
    if (!ok) return;
  }
  if (btn.dataset.action === 'transfer') {
    const ok = await AppModal.confirm({
      title: 'Transfer ownership',
      message: `Send ${target.username} a request to become the owner?`,
      confirmText: 'Send request',
    });
    if (!ok) return;
  }
  const action = btn.dataset.action;
  const eventMap = {
    mute: 'host:mute', kick: 'host:kick', promote: 'host:role', demote: 'host:role',
    transfer: 'host:transfer:request',
  };
  const payload = { targetId: btn.dataset.id };
  if (action === 'promote' || action === 'demote') payload.action = action;
  socket.emit(eventMap[action], payload, (resp) => {
    if (!resp || !resp.ok) showToast((resp && resp.message) || 'Action failed');
  });
});

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
}
function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function appendMessage(msg) {
  const stick = isNearBottom();
  const div = document.createElement('div');
  div.className = 'message ' + msg.type;
  if (msg.type === 'system') {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.text;
    div.appendChild(bubble);
    lastChatMessage = null;
  } else {
    const sender = lastUserList.find((u) => u.username === msg.username);
    const grouped = !!(lastChatMessage && lastChatMessage.username === msg.username);
    if (msg.username === myUsername) div.classList.add('me');
    if (grouped) div.classList.add('grouped');
    if (grouped) {
      const sp = document.createElement('span');
      sp.style.cssText = 'width:32px;flex:none';
      div.appendChild(sp);
    } else {
      const av = document.createElement('span');
      av.className = 'avatar avatar-' + (sender ? sender.role : 'member');
      av.textContent = String(msg.username || '?').trim().split(/[\s_.\-]+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('') || '?';
      div.appendChild(av);
    }
    const body = document.createElement('div');
    body.className = 'message-body';
    if (!grouped) {
      const head = document.createElement('div');
      head.className = 'message-head';
      const name = document.createElement('span');
      name.className = 'username';
      name.textContent = msg.username;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      head.append(name, meta);
      body.appendChild(head);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.text;
    body.appendChild(bubble);
    div.appendChild(body);
    lastChatMessage = msg;
  }
  messagesEl.appendChild(div);
  if (stick) scrollToBottom();
}
let lastChatMessage = null;

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
const emojiBtn = document.getElementById('emojiBtn');
const emojiPicker = document.getElementById('emojiPicker');
['😀','😂','🥹','😍','🤔','👍','🔥','✨','🎉','❤️','🙏','👀','🚀','💬','😎','🥳','💡','🎬','🍿','👋'].forEach((em) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = em;
  b.addEventListener('click', () => {
    const start = messageInput.selectionStart ?? messageInput.value.length;
    messageInput.value = messageInput.value.slice(0, start) + em + messageInput.value.slice(messageInput.selectionEnd ?? start);
    messageInput.focus();
  });
  emojiPicker.appendChild(b);
});
emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPicker.style.display = emojiPicker.style.display === 'none' ? 'grid' : 'none';
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#emojiPicker') && e.target !== emojiBtn) emojiPicker.style.display = 'none';
});

document.getElementById('toggleUsersBtn').addEventListener('click', () => {
  const list = document.getElementById('users');
  const show = list.style.display === 'none';
  list.style.display = show ? '' : 'none';
  document.getElementById('toggleUsersBtn').setAttribute('aria-expanded', String(show));
  document.getElementById('toggleUsersBtn').textContent = show ? 'Participants ▾' : 'Participants ▸';
});

socket.on('chat:message', (msg) => appendMessage(msg));
socket.on('users:updated', (data) => renderUsers(data.users));
socket.on('user:joined', (data) => renderUsers(data.users));
socket.on('user:left', (data) => renderUsers(data.users));
socket.on('permissions:updated', (data) => {
  if (data.username !== myUsername) return;
  applyPermissions(data.role, data.muted);
});
socket.on('user:muted', (data) => {
  setMutedState(data.muted);
  showToast(data.muted ? 'You have been muted' : 'You have been unmuted');
});
socket.on('user:kicked', () => { deny('You were removed from the session by a moderator.'); });
socket.on('user:replaced', () => { deny('This session was opened in another tab.'); });
socket.on('host:transfer:offer', async (data) => {
  const accept = await AppModal.confirm({
    title: 'Ownership transfer request',
    message: `${data.from} wants to make you the owner. Accept?`,
    confirmText: 'Accept', cancelText: 'Reject',
  });
  socket.emit('host:transfer:respond', { id: data.id, accept }, (resp) => {
    if (!resp || !resp.ok) showToast((resp && resp.message) || 'Could not respond');
  });
});
socket.on('host:transfer:complete', (data) => {
  showToast(`${data.newOwner} is now the owner`);
  renderUsers(data.users);
});
socket.on('host:transfer:declined', (data) => showToast(`${data.by || 'The participant'} declined the transfer`));
socket.on('disconnect', () => setMutedState(true));
