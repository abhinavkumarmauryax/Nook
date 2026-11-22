#!/usr/bin/env node
/* Nook - Copyright (c) 2026 Abhi. Source-available, non-commercial licence. See LICENSE. */
'use strict';

/**
 * Nook – self-hosted synchronized video + chat server.
 *
 * Architecture:
 *   - Bootstrap server (env PORT, default 3000): serves the "Server Setup" UI and
 *     starts/stops the actual session server on a user-chosen port.
 *   - Session server (0.0.0.0:<chosen port>): serves the join/watch/chat pages,
 *     streams the selected video with HTTP range support, and runs Socket.IO
 *     for playback synchronization, chat and moderation.
 *   - All session state is in-memory. No database, no cloud, no accounts.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Server: IOServer } = require('socket.io');

// -------------------- configuration --------------------
const APP_ROOT = __dirname;
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const TEMP_DIR = path.join(os.tmpdir(), 'nook');
const HOME_DIR = os.homedir();

const BOOTSTRAP_PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_VIDEO_SIZE_GB = parseInt(process.env.MAX_VIDEO_SIZE_GB || '2', 10);
const MAX_VIDEO_SIZE = MAX_VIDEO_SIZE_GB * 1024 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 500;
const MAX_CHAT_MESSAGES = 300;
const USERNAME_RE = /^[a-zA-Z0-9 _.\-]{2,32}$/;
const ALLOWED_VIDEO_EXTS = ['.mp4', '.webm', '.ogg', '.mov', '.m4v'];
const RATE_LIMIT_WINDOW_MS = 10000;
const RATE_LIMIT_MAX = 30;
const TRANSFER_TIMEOUT_MS = 60000;
const KICK_COOLDOWN_MS = 30000;

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// -------------------- shared session state --------------------
let sessionServer = null;
let sessionIo = null;
let sessionPort = null;
let sessionUrl = null;
let hostToken = null;
let sessionStartError = null;

let currentVideo = null;          // { kind:'file'|'url', path?, url?, name, size?, type? }
let currentVideoTempPath = null;

const playbackState = {
  videoKey: null,
  isPlaying: false,
  currentTime: 0,
  lastUpdate: 0,
  duration: 0,
};

// socketId -> { id, username, role:'owner'|'admin'|'member', joinedAt, kicked,
//               sessionToken, chatSocketIds:Set }
const users = new Map();
const recentUsers = new Map(); // short-lived snapshots so a reconnect can restore role
const mutedUsers = new Set();     // lowercase usernames, survives reconnect
const kickedCooldown = new Map(); // lowercase username -> expiry timestamp
const chatMessages = [];
const msgTimes = new Map();
let pendingTransfer = null;      // { id, fromId, toId, expires }
let ownerGraceTimer = null;      // short delay before auto-promoting a new owner
let ownerGraceToken = null;
let invariantTimer = null;
let ownershipTransferred = false;
let roleSequence = 0;
function nextRoleSeq() { return ++roleSequence; }

// -------------------- helpers --------------------
function getLocalIPv4Addresses() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

function sessionBaseUrl(port) {
  const ips = getLocalIPv4Addresses();
  return `http://${ips[0] || 'localhost'}:${port}`;
}

function computePlaybackTime() {
  if (!playbackState.isPlaying) return playbackState.currentTime;
  const elapsed = (Date.now() - playbackState.lastUpdate) / 1000;
  return Math.max(0, playbackState.currentTime + elapsed);
}

function addChatMessage(username, text, type = 'chat') {
  const msg = {
    id: crypto.randomUUID(),
    username: type === 'system' ? '' : username,
    text: String(text),
    timestamp: Date.now(),
    type,
  };
  chatMessages.push(msg);
  if (chatMessages.length > MAX_CHAT_MESSAGES) chatMessages.shift();
  return msg;
}

function emitSystem(text) {
  const msg = addChatMessage('system', text, 'system');
  if (sessionIo) sessionIo.emit('chat:message', msg);
}

function videoDescriptor() {
  if (!currentVideo) return null;
  return {
    kind: currentVideo.kind,
    name: currentVideo.name,
    size: currentVideo.size || 0,
    type: currentVideo.type || '',
    url: currentVideo.kind === 'url' ? currentVideo.url : null,
    key: playbackState.videoKey,
  };
}

function broadcastPlaybackState(io, onlySocket = null) {
  const payload = {
    videoKey: playbackState.videoKey,
    video: videoDescriptor(),
    isPlaying: playbackState.isPlaying,
    currentTime: computePlaybackTime(),
    duration: playbackState.duration,
    timestamp: Date.now(),
  };
  if (onlySocket) onlySocket.emit('playback:state', payload);
  else io.emit('playback:state', payload);
}

function userListPayload() {
  return Array.from(users.values()).map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    isHost: u.role === 'owner',
    muted: mutedUsers.has(u.username.toLowerCase()),
    joinedAt: u.joinedAt,
  }));
}

function getUserFromSocket(socket) {
  const direct = users.get(socket.id);
  if (direct) return direct;
  const boundId = socket.data && socket.data.userId;
  return boundId ? users.get(boundId) || null : null;
}

function isOwner(user) {
  return !!user && user.role === 'owner';
}

// Shared playback may be driven by the owner or an admin. Video source changes
// remain owner-only.
function canControlPlayback(user) {
  return !!user && (user.role === 'owner' || user.role === 'admin');
}

// Owner may moderate anyone except the owner. Admin may only moderate members.
function canModerate(actor, target) {
  if (!actor || !target || target.role === 'owner') return false;
  if (actor.role === 'owner') return true;
  return actor.role === 'admin' && target.role === 'member';
}

// Safety net: regardless of races between disconnect/reconnect and role
// changes, the session must never have more than one owner.
function enforceSingleOwner() {
  const owners = Array.from(users.values()).filter((u) => u.role === 'owner');
  if (owners.length <= 1) return false;
  owners.sort((a, b) => (b.roleChangedAt || 0) - (a.roleChangedAt || 0));
  const keep = owners[0];
  for (const u of owners.slice(1)) {
    u.role = u.roleBeforeOwner || 'member';
    delete u.roleBeforeOwner;
    u.roleChangedAt = nextRoleSeq();
  }
  if (sessionIo) {
    sessionIo.emit('users:updated', { users: userListPayload() });
    emitPermissions(sessionIo);
  }
  console.log('[session] normalized multiple owners, kept', keep.username);
  return true;
}

function emitToUser(io, user, event, payload) {
  if (!user) return;
  const primary = io.sockets.sockets.get(user.id);
  if (primary) primary.emit(event, payload);
  for (const sid of user.chatSocketIds) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit(event, payload);
  }
}

function emitPermissions(io) {
  for (const socket of io.sockets.sockets.values()) {
    const user = getUserFromSocket(socket);
    if (!user) continue;
    socket.emit('permissions:updated', {
      username: user.username,
      isHost: user.role === 'owner',
      role: user.role,
      ownerToken: user.role === 'owner' ? user.ownerToken : null,
      muted: mutedUsers.has(user.username.toLowerCase()),
    });
  }
}

function validateMediaUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch {
    return { ok: false, error: 'Enter a valid URL (for example https://example.com/video.mp4)' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTP and HTTPS URLs are supported' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'URLs containing a username or password are not allowed' };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' ||
      host === '::' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.startsWith('169.254.')) {
    return { ok: false, error: 'Loopback, link-local and internal addresses are not allowed' };
  }
  // No server-side fetch/proxy happens here — the browser loads the URL directly.
  let name = 'Stream';
  try {
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (parts.length) name = parts[parts.length - 1].slice(0, 120);
  } catch {}
  return { ok: true, url: url.toString(), name };
}

// Resolve a host-supplied path safely. Only files under the host's own user
// folder are accepted, and symlinks are resolved so they cannot escape it.
function resolveLocalVideo(input) {
  let raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'Enter a file path' };
  if (raw.startsWith('~')) raw = path.join(HOME_DIR, raw.slice(1));
  let resolved;
  try { resolved = path.resolve(raw); } catch { return { ok: false, error: 'Invalid path' }; }
  let real;
  try { real = fs.realpathSync(resolved); } catch { return { ok: false, error: 'File not found' }; }
  let home;
  try { home = fs.realpathSync(HOME_DIR); } catch { home = HOME_DIR; }
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (!real.startsWith(prefix)) return { ok: false, error: 'Only files inside your user folder can be shared' };
  let stat;
  try { stat = fs.statSync(real); } catch { return { ok: false, error: 'Cannot read that file' }; }
  if (!stat.isFile()) return { ok: false, error: 'That is not a file' };
  const ext = path.extname(real).toLowerCase();
  if (!ALLOWED_VIDEO_EXTS.includes(ext))
    return { ok: false, error: 'Unsupported format. Use MP4, WebM, OGG, MOV or M4V.' };
  if (stat.size > MAX_VIDEO_SIZE)
    return { ok: false, error: `File too large (max ${MAX_VIDEO_SIZE_GB} GB)` };
  return { ok: true, path: real, name: path.basename(real), size: stat.size, type: ext };
}

function isAuthorizedOwner(req) {
  const suppliedHost = req.headers['x-host-token'] || (req.query && req.query.token);
  const suppliedOwner = req.headers['x-owner-token'] || (req.query && req.query.token);
  const currentOwner = Array.from(users.values()).find((u) => u.role === 'owner');
  return (hostToken && suppliedHost === hostToken && !ownershipTransferred) ||
    !!(currentOwner && suppliedOwner && suppliedOwner === currentOwner.ownerToken);
}

function activateVideo(descriptor, announceText) {
  const previousTemp = currentVideoTempPath;
  currentVideo = descriptor;
  // Only uploaded copies are temporary. A host-selected local path must never
  // be deleted � it stays on the host's disk and is streamed from there.
  currentVideoTempPath = descriptor.temp ? descriptor.path : null;
  if (previousTemp && previousTemp !== descriptor.path && fs.existsSync(previousTemp)) {
    try { fs.unlinkSync(previousTemp); } catch {}
  }
  playbackState.videoKey = crypto.randomUUID();
  playbackState.isPlaying = false;
  playbackState.currentTime = 0;
  playbackState.lastUpdate = Date.now();
  playbackState.duration = 0;
  const v = videoDescriptor();
  if (sessionIo) sessionIo.emit('video:changed', { video: v, system: announceText || null });
  console.log(`[session] video source: ${descriptor.kind} ${descriptor.name}`);
  return v;
}

function stopSession() {
  sessionStartError = null;
  if (sessionIo) { try { sessionIo.close(); } catch {} sessionIo = null; }
  if (sessionServer) { try { sessionServer.close(); } catch {} sessionServer = null; }
  sessionPort = null;
  sessionUrl = null;
  hostToken = null;
  if (currentVideoTempPath && fs.existsSync(currentVideoTempPath)) {
    try { fs.unlinkSync(currentVideoTempPath); } catch {}
  }
  currentVideo = null;
  currentVideoTempPath = null;
  playbackState.videoKey = null;
  playbackState.isPlaying = false;
  playbackState.currentTime = 0;
  playbackState.lastUpdate = 0;
  playbackState.duration = 0;
  users.clear();
  recentUsers.clear();
  mutedUsers.clear();
  kickedCooldown.clear();
  chatMessages.length = 0;
  msgTimes.clear();
  pendingTransfer = null;
  if (ownerGraceTimer) { clearTimeout(ownerGraceTimer); ownerGraceTimer = null; }
  ownerGraceToken = null;
  ownershipTransferred = false;
  if (invariantTimer) { clearInterval(invariantTimer); invariantTimer = null; }
  console.log('[session] stopped');
}

function startSessionServer(port) {
  return new Promise((resolve, reject) => {
    stopSession();

    const app = express();

    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type, X-Host-Token, X-Owner-Token, X-File-Name');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    app.use(express.static(PUBLIC_DIR));
    app.use(express.json({ limit: '16kb' }));

    // pkg snapshots cannot serve Socket.IO's client from node_modules at runtime.
    app.get('/socket.io/socket.io.js', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'js', 'socket.io.js')));

    app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'watch.html')));
    app.get('/watch', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'watch.html')));
    app.get('/join', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'join.html')));
    app.get('/chat', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'chat.html')));

    app.get('/api/video-info', (_req, res) => {
      if (!currentVideo) return res.status(404).json({ error: 'No video selected' });
      res.json(videoDescriptor());
    });

    app.get('/api/status', (_req, res) => res.json({
      running: true,
      port,
      homeDir: HOME_DIR,
      downloadsDir: path.join(HOME_DIR, 'Downloads'),
    }));

    // Share a video already on the host's disk - no upload/copy at all.
    app.post('/api/video/local', (req, res) => {
      if (!isAuthorizedOwner(req)) return res.status(401).json({ error: 'Owner authorization required' });
      const result = resolveLocalVideo(req.body && req.body.path);
      if (!result.ok) return res.status(400).json({ error: result.error });
      const video = activateVideo({
        kind: 'file', path: result.path, name: result.name,
        size: result.size, type: result.type, temp: false,
      });
      res.json({ ok: true, video });
    });

    // Small directory browser for the local-file picker (owner only).
    app.get('/api/browse', (req, res) => {
      if (!isAuthorizedOwner(req)) return res.status(401).json({ error: 'Owner authorization required' });
      let dir = String(req.query.dir || HOME_DIR);
      if (dir.startsWith('~')) dir = path.join(HOME_DIR, dir.slice(1));
      let real;
      try { real = fs.realpathSync(path.resolve(dir)); } catch {
        return res.status(400).json({ error: 'Folder not found' });
      }
      let home;
      try { home = fs.realpathSync(HOME_DIR); } catch { home = HOME_DIR; }
      const prefix = home.endsWith(path.sep) ? home : home + path.sep;
      if (real !== home && !real.startsWith(prefix))
        return res.status(403).json({ error: 'Only your user folder is accessible' });
      let entries = [];
      try { entries = fs.readdirSync(real, { withFileTypes: true }); } catch {}
      const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(real, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const files = entries.filter((e) => e.isFile() && ALLOWED_VIDEO_EXTS.includes(path.extname(e.name).toLowerCase()))
        .map((e) => {
          let size = 0;
          try { size = fs.statSync(path.join(real, e.name)).size; } catch {}
          return { name: e.name, path: path.join(real, e.name), size };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = real === home ? null : path.dirname(real);
      res.json({ current: real, parent, home: home, folders, files });
    });

    // Video upload (host token only). Streamed straight to disk.
    app.post('/api/video/upload', (req, res) => {
      if (!isAuthorizedOwner(req)) return res.status(401).json({ error: 'Owner authorization required' });
      const rawHeader = req.headers['x-file-name'];
      if (!rawHeader) return res.status(400).json({ error: 'File name missing' });
      let decodedName = String(rawHeader);
      try { decodedName = decodeURIComponent(decodedName); } catch {}
      const name = path.basename(decodedName).replace(/[^a-zA-Z0-9._\-]/g, '_') || 'video.bin';
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_VIDEO_EXTS.includes(ext)) {
        return res.status(400).json({ error: 'Unsupported video format. Use MP4, WebM, OGG, or MOV.' });
      }

      const tmpPath = path.join(TEMP_DIR, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${name}`);
      ensureTempDir();
      const out = fs.createWriteStream(tmpPath);
      let received = 0;
      let aborted = false;

      req.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_VIDEO_SIZE && !aborted) {
          aborted = true;
          out.destroy();
          try { fs.unlinkSync(tmpPath); } catch {}
          return res.status(413).json({ error: `File too large (max ${MAX_VIDEO_SIZE_GB} GB)` });
        }
      });
      req.pipe(out);

      out.on('finish', () => {
        if (aborted) return;
        let stat;
        try { stat = fs.statSync(tmpPath); } catch {
          return res.status(500).json({ error: 'Failed to save uploaded video' });
        }
        const v = activateVideo({ kind: 'file', path: tmpPath, name, size: stat.size, type: ext, temp: true });
        res.json({ ok: true, video: v });
      });
      out.on('error', () => {
        if (aborted) return;
        res.status(500).json({ error: 'Failed to save video' });
      });
    });

    // Local-file streaming with HTTP range support (URL sources are loaded by browsers directly).
    app.get('/video', (req, res) => {
      if (!currentVideo || currentVideo.kind !== 'file') {
        return res.status(404).json({ error: 'No local video selected' });
      }
      let stat;
      try { stat = fs.statSync(currentVideo.path); } catch {
        return res.status(404).json({ error: 'Video file not found' });
      }
      const fileSize = stat.size;
      const range = req.headers.range;
      const typeMap = {
        '.mp4': 'video/mp4', '.m4v': 'video/mp4',
        '.webm': 'video/webm', '.ogg': 'video/ogg', '.mov': 'video/quicktime',
      };
      const contentType = typeMap[path.extname(currentVideo.path).toLowerCase()] || 'video/mp4';

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        let start, end;
        if (parts[0] === '') {
          end = fileSize - 1;
          start = Math.max(0, fileSize - parseInt(parts[1], 10));
        } else {
          start = parseInt(parts[0], 10);
          end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        }
        if (start >= fileSize || !isFinite(start)) {
          res.status(416).send('Requested range not satisfiable');
          return;
        }
        end = Math.min(end, fileSize - 1);
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
        });
        fs.createReadStream(currentVideo.path, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Accept-Ranges': 'bytes',
          'Content-Type': contentType,
        });
        fs.createReadStream(currentVideo.path).pipe(res);
      }
    });

    const srv = http.createServer(app);
    const io = new IOServer(srv, {
      cors: { origin: '*' },
      pingTimeout: 20000,
      pingInterval: 5000,
    });

    invariantTimer = setInterval(enforceSingleOwner, 2000);

    // ---------------- Socket.IO ----------------
    io.on('connection', (socket) => {
      function ack(cb, ok, message, extra) {
        if (typeof cb === 'function') cb({ ok, message, ...(extra || {}) });
      }

      // ---- join / session-bound token ----
      socket.on('join:request', (data, cb) => {
        const { username, hostToken: token, sessionToken } = data || {};
        if (!username || typeof username !== 'string') return ack(cb, false, 'Username is required');
        const trimmed = username.trim();
        if (trimmed.length < 2 || trimmed.length > 32)
          return ack(cb, false, 'Username must be between 2 and 32 characters');
        if (!USERNAME_RE.test(trimmed))
          return ack(cb, false, 'Username contains invalid characters');

        const key = trimmed.toLowerCase();
        const cooldown = kickedCooldown.get(key);
        if (cooldown && cooldown > Date.now())
          return ack(cb, false, 'You were recently removed from this session. Please wait before rejoining.');
        kickedCooldown.delete(key);

        // A brief disconnect removes the live record; restore role from the cache.
        let restored = null;
        if (sessionToken && recentUsers.has(sessionToken)) {
          const snapshot = recentUsers.get(sessionToken);
          recentUsers.delete(sessionToken);
          if (snapshot.expires > Date.now() && snapshot.username.toLowerCase() === key) restored = snapshot;
        }
        if (restored && restored.role === 'owner' && ownerGraceTimer) {
          clearTimeout(ownerGraceTimer); ownerGraceTimer = null; ownerGraceToken = null;
        }

        // Reconnect using an existing session token keeps role, mute and identity.
        const existingByToken = sessionToken
          ? Array.from(users.values()).find((u) => u.sessionToken === sessionToken)
          : null;
        if (existingByToken && existingByToken.id !== socket.id) {
          const oldPrimary = io.sockets.sockets.get(existingByToken.id);
          // A returning owner cancels any pending auto-promotion.
          if (ownerGraceTimer && ownerGraceToken === existingByToken.sessionToken) {
            clearTimeout(ownerGraceTimer); ownerGraceTimer = null; ownerGraceToken = null;
          }
          // Rebind first so the old socket's disconnect handler cannot remove the user.
          for (const [sid, u] of users.entries()) if (u === existingByToken) users.delete(sid);
          existingByToken.id = socket.id;
          users.set(socket.id, existingByToken);
          // Enforce exactly one owner: demote anyone auto-promoted while this user was away.
          if (existingByToken.role === 'owner') {
            for (const u of users.values()) {
              if (u !== existingByToken && u.role === 'owner') {
                u.role = u.roleBeforeOwner || 'member';
                delete u.roleBeforeOwner;
              }
            }
          }
          if (oldPrimary) {
            oldPrimary.emit('user:replaced', { message: 'You joined from another device or tab.' });
            oldPrimary.disconnect(true);
          }
          const p = sessionPayload(socket, existingByToken);
          ack(cb, true, null, p);
          socket.emit('joined', p);
          broadcastPlaybackState(io, socket);
          emitPermissions(io);
          return;
        }

        let preservedRole = null;
        const existingName = Array.from(users.entries()).find(([, u]) => u.username.toLowerCase() === key);
        if (existingName && existingName[0] !== socket.id) {
          const oldUser = existingName[1];
          if (oldUser.role === 'owner') {
            preservedRole = 'owner';
            if (ownerGraceTimer) { clearTimeout(ownerGraceTimer); ownerGraceTimer = null; ownerGraceToken = null; }
          }
          const oldSocket = io.sockets.sockets.get(existingName[0]);
          if (oldSocket) {
            oldSocket.emit('user:replaced', { message: 'You joined from another device or tab.' });
            oldSocket.disconnect(true);
          }
          users.delete(existingName[0]);
        }

        const isFirst = users.size === 0;
        const hostClaim = token && token === hostToken && !ownershipTransferred;
        let role = preservedRole || (restored ? restored.role : ((hostClaim || isFirst) ? 'owner' : 'member'));
        if (role === 'owner') {
          for (const u of users.values()) {
            if (u.role === 'owner') { u.role = u.roleBeforeOwner || 'member'; delete u.roleBeforeOwner; }
          }
        }
        const user = {
          id: socket.id,
          username: trimmed,
          role,
          joinedAt: Date.now(),
          roleChangedAt: nextRoleSeq(),
          kicked: false,
          sessionToken: sessionToken && /^[a-zA-Z0-9\-]{16,128}$/.test(sessionToken)
            ? sessionToken : crypto.randomBytes(24).toString('hex'),
          ownerToken: crypto.randomBytes(16).toString('hex'),
          chatSocketIds: new Set(),
        };
        users.set(socket.id, user);
        console.log(`[session] ${trimmed} joined (${role})`);

        const p = sessionPayload(socket, user);
        ack(cb, true, null, p);
        socket.emit('joined', p);
        broadcastPlaybackState(io, socket);
        io.emit('user:joined', { username: trimmed, users: userListPayload() });
        emitSystem(`${trimmed} joined the session`);
        emitPermissions(io);
      });

      function sessionPayload(socket, user) {
        return {
          username: user.username,
          isHost: user.role === 'owner',
          role: user.role,
          socketId: socket.id,
          userId: user.id,
          sessionToken: user.sessionToken,
          ownerToken: user.role === 'owner' ? user.ownerToken : null,
          users: userListPayload(),
          messages: chatMessages.slice().reverse(),
          videoKey: playbackState.videoKey,
          video: videoDescriptor(),
          playback: {
            videoKey: playbackState.videoKey,
            isPlaying: playbackState.isPlaying,
            currentTime: computePlaybackTime(),
            duration: playbackState.duration,
            timestamp: Date.now(),
          },
        };
      }

      // ---- standalone chat authentication (token from URL fragment) ----
      socket.on('chat:auth', (data, cb) => {
        const token = data && data.token;
        const user = token ? Array.from(users.values()).find((u) => u.sessionToken === token) : null;
        if (!user) return ack(cb, false, 'Your session is invalid or has ended. Please join the session first.');
        socket.data.userId = user.id;
        user.chatSocketIds.add(socket.id);
        const p = {
          username: user.username,
          isHost: user.role === 'owner',
          role: user.role,
          muted: mutedUsers.has(user.username.toLowerCase()),
          users: userListPayload(),
          messages: chatMessages.slice().reverse(),
        };
        ack(cb, true, null, p);
        socket.emit('chat:ready', p);
      });

      // ---- chat ----
      socket.on('chat:message', (data, cb) => {
        const user = getUserFromSocket(socket);
        if (!user) return ack(cb, false, 'Not joined');
        if (mutedUsers.has(user.username.toLowerCase()))
          return ack(cb, false, 'You have been muted by the host');
        const text = data && data.text;
        if (!text || !String(text).trim()) return ack(cb, false, 'Message is empty');
        const msg = String(text).trim();
        if (msg.length > MAX_MESSAGE_LENGTH)
          return ack(cb, false, `Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);

        const now = Date.now();
        const times = (msgTimes.get(socket.id) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        if (times.length >= RATE_LIMIT_MAX)
          return ack(cb, false, 'Slow down! You are sending messages too quickly.');
        times.push(now);
        msgTimes.set(socket.id, times);

        const out = addChatMessage(user.username, msg, 'chat');
        io.emit('chat:message', out);
        ack(cb, true, null, { id: out.id });
      });

      // ---- playback (owner only, enforced here) ----
      socket.on('playback:control', (data, cb) => {
        const user = getUserFromSocket(socket);
        if (!canControlPlayback(user)) return ack(cb, false, 'Only the owner or an admin can control playback');
        const { action, time } = data || {};
        const now = Date.now();
        const current = computePlaybackTime();

        if (action === 'play') {
          playbackState.isPlaying = true;
          playbackState.currentTime = time !== undefined ? Math.max(0, time) : current;
          playbackState.lastUpdate = now;
        } else if (action === 'pause') {
          playbackState.isPlaying = false;
          playbackState.currentTime = time !== undefined ? Math.max(0, time) : current;
          playbackState.lastUpdate = now;
        } else if (action === 'seek') {
          if (time === undefined) return ack(cb, false, 'Seek time required');
          playbackState.currentTime = Math.max(0, time);
          playbackState.lastUpdate = now;
        } else {
          return ack(cb, false, 'Unknown playback action');
        }
        // Never echo the command back to the sender — that caused a broadcast
        // storm when multiple controllers re-emitted states they just applied.
        socket.broadcast.emit('playback:control', {
          action,
          time: playbackState.currentTime,
          isPlaying: playbackState.isPlaying,
          timestamp: now,
          originator: socket.id,
        });
        ack(cb, true);
      });

      socket.on('video:duration', (data, cb) => {
        const user = getUserFromSocket(socket);
        if (!canControlPlayback(user)) return ack(cb, false, 'Owner or admin only');
        const { duration } = data || {};
        if (typeof duration === 'number' && isFinite(duration)) playbackState.duration = duration;
        ack(cb, true);
      });

      // ---- video URL (owner only) ----
      socket.on('video:url', (data, cb) => {
        const user = getUserFromSocket(socket);
        if (!isOwner(user)) return ack(cb, false, 'Only the owner can change the video');
        const check = validateMediaUrl(data && data.url);
        if (!check.ok) return ack(cb, false, check.error);
        const title = data && typeof data.title === 'string' ? data.title.trim().slice(0, 120) : '';
        const v = activateVideo({ kind: 'url', url: check.url, name: title || check.name, type: 'url' });
        ack(cb, true, null, { video: v });
      });

      // ---- moderation ----
      socket.on('host:mute', (data, cb) => {
        const actor = getUserFromSocket(socket);
        const target = users.get(data && data.targetId);
        if (!canModerate(actor, target)) return ack(cb, false, 'You cannot moderate this participant');
        const key = target.username.toLowerCase();
        const shouldMute = !mutedUsers.has(key);
        if (shouldMute) mutedUsers.add(key); else mutedUsers.delete(key);
        emitToUser(io, target, 'user:muted', { muted: shouldMute });
        io.emit('users:updated', { users: userListPayload() });
        emitSystem(`${target.username} ${shouldMute ? 'was muted' : 'was unmuted'} by ${actor.username}`);
        emitPermissions(io);
        ack(cb, true);
      });

      socket.on('host:kick', (data, cb) => {
        const actor = getUserFromSocket(socket);
        const target = users.get(data && data.targetId);
        if (!canModerate(actor, target)) return ack(cb, false, 'You cannot moderate this participant');
        target.kicked = true;
        target.sessionToken = null;
        kickedCooldown.set(target.username.toLowerCase(), Date.now() + KICK_COOLDOWN_MS);
        emitSystem(`${target.username} was removed by ${actor.username}`);
        emitToUser(io, target, 'user:kicked', { message: 'You were removed from the session by a moderator.' });
        const primary = io.sockets.sockets.get(target.id);
        if (primary) setTimeout(() => primary.disconnect(true), 100);
        for (const sid of target.chatSocketIds) {
          const s = io.sockets.sockets.get(sid);
          if (s) setTimeout(() => s.disconnect(true), 100);
        }
        ack(cb, true);
      });

      socket.on('host:role', (data, cb) => {
        const actor = getUserFromSocket(socket);
        if (!isOwner(actor)) return ack(cb, false, 'Only the owner can manage admins');
        const target = users.get(data && data.targetId);
        if (!target) return ack(cb, false, 'Participant not found');
        const action = data && data.action;
        if (action === 'promote') {
          if (target.role !== 'member') return ack(cb, false, 'This participant is not a regular member');
          target.role = 'admin';
          target.roleChangedAt = nextRoleSeq();
          emitSystem(`${target.username} was promoted to admin`);
        } else if (action === 'demote') {
          if (target.role !== 'admin') return ack(cb, false, 'This participant is not an admin');
          target.role = 'member';
          target.roleChangedAt = nextRoleSeq();
          emitSystem(`${target.username} was demoted to member`);
        } else {
          return ack(cb, false, 'Unknown role action');
        }
        io.emit('users:updated', { users: userListPayload() });
        emitPermissions(io);
        ack(cb, true);
      });

      // ---- host transfer: owner requests, target accepts/rejects ----
      socket.on('host:transfer:request', (data, cb) => {
        const actor = getUserFromSocket(socket);
        if (!isOwner(actor)) return ack(cb, false, 'Only the owner can transfer ownership');
        const target = users.get(data && data.targetId);
        if (!target) return ack(cb, false, 'Participant not found');
        if (target.role === 'owner') return ack(cb, false, 'You are already the owner');
        if (pendingTransfer && pendingTransfer.expires > Date.now())
          return ack(cb, false, 'A transfer request is already pending');
        pendingTransfer = {
          id: crypto.randomUUID(),
          fromId: actor.id,
          toId: target.id,
          expires: Date.now() + TRANSFER_TIMEOUT_MS,
        };
        emitToUser(io, target, 'host:transfer:offer', {
          id: pendingTransfer.id,
          from: actor.username,
        });
        ack(cb, true, null, { target: target.username });
      });

      socket.on('host:transfer:respond', (data, cb) => {
        const user = getUserFromSocket(socket);
        if (!user || !pendingTransfer || pendingTransfer.toId !== user.id ||
            pendingTransfer.expires <= Date.now())
          return ack(cb, false, 'There is no pending transfer for you');
        if (data && data.id && data.id !== pendingTransfer.id)
          return ack(cb, false, 'The transfer request has expired');
        const accepted = !!(data && data.accept);
        const from = users.get(pendingTransfer.fromId);
        const to = users.get(pendingTransfer.toId);
        pendingTransfer = null;
        if (!accepted) {
          emitToUser(io, from, 'host:transfer:declined', { by: user.username });
          emitSystem(`${user.username} declined the host transfer`);
          return ack(cb, true, null, { accepted: false });
        }
        if (!from || !to) return ack(cb, false, 'One of the participants has left');
        ownershipTransferred = true;
        if (ownerGraceTimer) { clearTimeout(ownerGraceTimer); ownerGraceTimer = null; ownerGraceToken = null; }
        from.role = 'member';
        from.roleChangedAt = nextRoleSeq();
        to.role = 'owner';
        to.roleChangedAt = nextRoleSeq();
        enforceSingleOwner();
        io.emit('host:transfer:complete', {
          previousOwner: from.username,
          newOwner: to.username,
          users: userListPayload(),
        });
        emitSystem(`${to.username} is now the owner. ${from.username} is now a member.`);
        io.emit('users:updated', { users: userListPayload() });
        emitPermissions(io);
        ack(cb, true, null, { accepted: true });
      });

      // ---- disconnect ----
      socket.on('disconnect', () => {
        // Pop-out chat sockets share an identity but are not separate participants.
        if (socket.data && socket.data.userId) {
          const owner = users.get(socket.data.userId);
          if (owner) owner.chatSocketIds.delete(socket.id);
          return;
        }
        const user = users.get(socket.id);
        if (!user) return;
        if (user.sessionToken && !user.kicked) {
          recentUsers.set(user.sessionToken, {
            username: user.username,
            role: user.role,
            roleChangedAt: user.roleChangedAt,
            expires: Date.now() + 30000,
          });
        }
        users.delete(socket.id);
        console.log(`[session] ${user.username} disconnected (${user.role})`);

        if (pendingTransfer && (pendingTransfer.toId === socket.id || pendingTransfer.fromId === socket.id)) {
          const other = users.get(pendingTransfer.toId === socket.id ? pendingTransfer.fromId : pendingTransfer.toId);
          pendingTransfer = null;
          emitToUser(io, other, 'host:transfer:declined', { by: user.username, reason: 'left' });
        }

        io.emit('user:left', { username: user.username, users: userListPayload() });
        if (!user.kicked) emitSystem(`${user.username} left the session`);

        // If the owner left, wait briefly before auto-promoting. A page reload or
        // network blip reconnects with the same session token and cancels this.
        if (user.role === 'owner' && users.size > 0) {
          if (ownerGraceTimer) clearTimeout(ownerGraceTimer);
          ownerGraceToken = user.sessionToken;
          ownerGraceTimer = setTimeout(() => {
            ownerGraceTimer = null;
            ownerGraceToken = null;
            if (ownershipTransferred) return; // a real transfer already decided ownership
            const candidates = Array.from(users.values()).filter((u) => u.role !== 'owner');
            if (!candidates.length) return;
            const next = candidates.find((u) => u.role === 'admin') || candidates[0];
            ownershipTransferred = true;
            next.roleBeforeOwner = next.role;
            next.role = 'owner';
            next.roleChangedAt = nextRoleSeq();
            enforceSingleOwner();
            emitSystem(`${next.username} is now the owner.`);
            io.emit('host:transfer:complete', {
              previousOwner: user.username,
              newOwner: next.username,
              users: userListPayload(),
            });
            io.emit('users:updated', { users: userListPayload() });
            emitPermissions(io);
          }, 5000);
        }
        emitPermissions(io);
      });
    });

    const listenReady = new Promise((listenResolve, listenReject) => {
      srv.once('error', listenReject);
      srv.listen(port, '0.0.0.0', () => {
        srv.removeListener('error', listenReject);
        sessionServer = srv;
        sessionIo = io;
        sessionPort = port;
        sessionUrl = sessionBaseUrl(port);
        hostToken = crypto.randomBytes(16).toString('hex');
        console.log(`[session] listening on 0.0.0.0:${sessionPort} (${sessionUrl})`);
        listenResolve({ port, url: sessionUrl, hostToken, chatUrl: `${sessionUrl}/chat` });
      });
    });

    listenReady.then(resolve).catch((err) => {
      sessionStartError = err.message;
      console.error('[session] failed to start:', err.message);
      reject(err);
    });
  });
}

// -------------------- bootstrap server --------------------
const bootstrapApp = express();
bootstrapApp.use(express.static(PUBLIC_DIR));
bootstrapApp.use(express.json({ limit: '1mb' }));

bootstrapApp.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'setup.html')));

bootstrapApp.get('/api/status', (_req, res) => {
  res.json({
    running: !!sessionServer,
    port: sessionPort,
    url: sessionUrl,
    hostToken,
    homeDir: HOME_DIR,
    downloadsDir: path.join(HOME_DIR, 'Downloads'),
    ips: getLocalIPv4Addresses(),
    participants: sessionIo ? sessionIo.engine.clientsCount : 0,
    video: currentVideo ? { name: currentVideo.name, size: currentVideo.size, kind: currentVideo.kind } : null,
    error: sessionStartError,
  });
});

bootstrapApp.post('/api/start', async (req, res) => {
  if (sessionServer) return res.status(400).json({ error: 'Session server already running' });
  const p = parseInt((req.body || {}).port, 10);
  if (!p || p < 1024 || p > 65535)
    return res.status(400).json({ error: 'Invalid port (choose 1024-65535)' });
  try {
    res.json({ ok: true, ...(await startSessionServer(p)) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to start session server' });
  }
});

bootstrapApp.post('/api/stop', (_req, res) => {
  stopSession();
  res.json({ ok: true });
});

bootstrapApp.use((err, _req, res, _next) => {
  console.error('[bootstrap]', err);
  res.status(500).json({ error: 'Server error' });
});

const bootstrapServer = http.createServer(bootstrapApp);
bootstrapServer.listen(BOOTSTRAP_PORT, () => {
  console.log(`[bootstrap] setup UI available at http://localhost:${BOOTSTRAP_PORT}`);
});
