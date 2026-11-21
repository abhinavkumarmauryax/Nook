#!/usr/bin/env node
'use strict';

/**
 * Local Watch Together – self-hosted synchronized video + chat server.
 *
 * Architecture:
 *   - Bootstrap server (env PORT, default 3000): serves the "Server Setup" UI and
 *     starts/stops the actual session server on a user-chosen port.
 *   - Session server (0.0.0.0:<chosen port>): serves the join/watch pages,
 *     streams the selected video with HTTP range support, and runs Socket.IO
 *     for playback synchronization and chat.
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
const TEMP_DIR = path.join(os.tmpdir(), 'local-watch-together');

const BOOTSTRAP_PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_VIDEO_SIZE_GB = parseInt(process.env.MAX_VIDEO_SIZE_GB || '2', 10);
const MAX_VIDEO_SIZE = MAX_VIDEO_SIZE_GB * 1024 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 500;
const MAX_CHAT_MESSAGES = 300;
const USERNAME_RE = /^[a-zA-Z0-9 _.\-]{2,32}$/;
const ALLOWED_VIDEO_EXTS = ['.mp4', '.webm', '.ogg', '.mov', '.m4v'];
const RATE_LIMIT_WINDOW_MS = 10000;
const RATE_LIMIT_MAX = 30;

// Temp directory is created lazily on first video upload (pkg snapshots are read-only at load time)
function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

// -------------------- shared session state --------------------
let sessionServer = null;
let sessionIo = null;
let sessionPort = null;
let sessionUrl = null;
let hostToken = null;
let sessionStartError = null;

let currentVideo = null;
let currentVideoTempPath = null;

const playbackState = {
  videoKey: null,
  isPlaying: false,
  currentTime: 0,
  lastUpdate: 0,
  duration: 0,
};

const users = new Map();      // socketId -> { username, isHost, joinedAt, kicked }
const mutedUsers = new Set(); // lowercase usernames muted by the host (survives reconnect)
const chatMessages = [];      // { id, username, text, timestamp, type }
const msgTimes = new Map();   // socketId -> [timestamps] for rate limiting

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

function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function addChatMessage(username, text, type = 'chat') {
  const msg = {
    id: crypto.randomUUID(),
    username: type === 'system' ? '' : username,
    text: type === 'system' ? text : escapeHtml(text),
    timestamp: Date.now(),
    type,
  };
  chatMessages.push(msg);
  if (chatMessages.length > MAX_CHAT_MESSAGES) chatMessages.shift();
  return msg;
}

function broadcastPlaybackState(io, onlySocket = null) {
  const payload = {
    videoKey: playbackState.videoKey,
    video: currentVideo
      ? { name: currentVideo.name, size: currentVideo.size, key: playbackState.videoKey }
      : null,
    isPlaying: playbackState.isPlaying,
    currentTime: computePlaybackTime(),
    duration: playbackState.duration,
    timestamp: Date.now(),
  };
  if (onlySocket) onlySocket.emit('playback:state', payload);
  else io.emit('playback:state', payload);
}

function userListPayload() {
  return Array.from(users.entries()).map(([id, u]) => ({
    id,
    username: u.username,
    isHost: u.isHost,
    muted: mutedUsers.has(u.username.toLowerCase()),
    joinedAt: u.joinedAt,
  }));
}

function stopSession() {
  sessionStartError = null;
  if (sessionIo) {
    try { sessionIo.close(); } catch {}
    sessionIo = null;
  }
  if (sessionServer) {
    try { sessionServer.close(); } catch {}
    sessionServer = null;
  }
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
  mutedUsers.clear();
  chatMessages.length = 0;
  console.log('[session] stopped');
}

function startSessionServer(port) {
  return new Promise((resolve, reject) => {
    stopSession();

    const app = express();

    // CORS headers (trusted local network; setup UI may run on a different port)
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type, X-Host-Token, X-File-Name');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    app.use(express.static(PUBLIC_DIR));

    // pkg snapshots cannot serve Socket.IO's client from node_modules at runtime.
    // Always serve our bundled copy (public/js/socket.io.js) for the canonical path too.
    app.get('/socket.io/socket.io.js', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'js', 'socket.io.js')));

    app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'watch.html')));
    app.get('/watch', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'watch.html')));
    app.get('/join', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'join.html')));

    app.get('/api/video-info', (req, res) => {
      if (!currentVideo) return res.status(404).json({ error: 'No video selected' });
      res.json({
        name: currentVideo.name,
        size: currentVideo.size,
        type: currentVideo.type,
        key: playbackState.videoKey,
      });
    });

    // Video upload (host only). Streamed straight to disk, never held in memory.
    app.post('/api/video/upload', (req, res) => {
      const token = req.headers['x-host-token'];
      if (!hostToken || token !== hostToken) {
        return res.status(401).json({ error: 'Host token required' });
      }
      const rawName = req.headers['x-file-name'];
      if (!rawName) return res.status(400).json({ error: 'File name missing' });

      const name = path.basename(String(rawName)).replace(/[^a-zA-Z0-9._\-]/g, '_') || 'video.bin';
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

        // Replace previous video (old temp file is deleted)
        if (currentVideoTempPath && fs.existsSync(currentVideoTempPath)) {
          try { fs.unlinkSync(currentVideoTempPath); } catch {}
        }

        currentVideo = { path: tmpPath, name, size: stat.size, type: ext };
        currentVideoTempPath = tmpPath;

        playbackState.videoKey = crypto.randomUUID();
        playbackState.isPlaying = false;
        playbackState.currentTime = 0;
        playbackState.lastUpdate = Date.now();
        playbackState.duration = 0;

        console.log(`[session] video selected: ${name} (${stat.size} bytes)`);
        if (sessionIo) {
          sessionIo.emit('video:changed', {
            video: { name, size: stat.size, type: ext, key: playbackState.videoKey },
          });
        }

        res.json({ ok: true, video: { name, size: stat.size, type: ext, key: playbackState.videoKey } });
      });

      out.on('error', () => {
        if (aborted) return;
        res.status(500).json({ error: 'Failed to save video' });
      });
    });

    // Video streaming with HTTP range request support (enables seeking)
    app.get('/video', (req, res) => {
      if (!currentVideo) return res.status(404).json({ error: 'No video selected' });
      let stat;
      try { stat = fs.statSync(currentVideo.path); } catch {
        return res.status(404).json({ error: 'Video file not found' });
      }
      const fileSize = stat.size;
      const range = req.headers.range;

      const typeMap = {
        '.mp4': 'video/mp4', '.m4v': 'video/mp4',
        '.webm': 'video/webm', '.ogg': 'video/ogg',
        '.mov': 'video/quicktime',
      };
      const contentType = typeMap[path.extname(currentVideo.path).toLowerCase()] || 'video/mp4';

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        let start, end;
        if (parts[0] === '') {
          // Suffix-byte-range-spec (e.g. bytes=-500)
          end = fileSize - 1;
          start = Math.max(0, fileSize - parseInt(parts[1], 10));
        } else {
          start = parseInt(parts[0], 10);
          end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        }
        if (start >= fileSize) {
          res.status(416).send('Requested range not satisfiable');
          return;
        }
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

    // ---------------- Socket.IO ----------------
    io.on('connection', (socket) => {
      console.log('[session] socket connected:', socket.id);

      function ack(cb, ok, message, extra) {
        if (typeof cb === 'function') cb({ ok, message, ...extra });
      }

      socket.on('join:request', (data, cb) => {
        const { username, hostToken: token } = data || {};
        if (!username || typeof username !== 'string') return ack(cb, false, 'Username is required');
        const trimmed = username.trim();
        if (trimmed.length < 2 || trimmed.length > 32)
          return ack(cb, false, 'Username must be between 2 and 32 characters');
        if (!USERNAME_RE.test(trimmed))
          return ack(cb, false, 'Username contains invalid characters');

        const isHost = token === hostToken || (users.size === 0 && !hostToken);

        // Duplicate username (case-insensitive). Replace stale socket on reconnect.
        const existing = [...users.entries()].find(([, u]) => u.username.toLowerCase() === trimmed.toLowerCase());
        if (existing && existing[0] !== socket.id) {
          const oldSocket = io.sockets.sockets.get(existing[0]);
          if (oldSocket) {
            oldSocket.emit('user:replaced', { message: 'You joined from another device or tab.' });
            oldSocket.disconnect(true);
          }
          users.delete(existing[0]);
        }

        users.set(socket.id, { username: trimmed, isHost, joinedAt: Date.now() });
        console.log(`[session] ${trimmed} joined (host=${isHost})`);

        const payload = {
          username: trimmed,
          isHost,
          socketId: socket.id,
          users: userListPayload(),
          messages: chatMessages.slice().reverse(),
          videoKey: playbackState.videoKey,
          video: currentVideo
            ? { name: currentVideo.name, size: currentVideo.size, type: currentVideo.type, key: playbackState.videoKey }
            : null,
          playback: {
            videoKey: playbackState.videoKey,
            isPlaying: playbackState.isPlaying,
            currentTime: computePlaybackTime(),
            duration: playbackState.duration,
            timestamp: Date.now(),
          },
        };
        ack(cb, true, null, payload);
        socket.emit('joined', payload);

        // The "joined" payload already carries the video key and playback state.
        // Do NOT also emit "video:changed" here: that would reset a new joiner's
        // pending playback state and leave them paused at the wrong position.
        broadcastPlaybackState(io, socket);

        io.emit('user:joined', { username: trimmed, isHost, users: userListPayload() });
        const sys = addChatMessage('system', `${escapeHtml(trimmed)} joined the session`, 'system');
        io.emit('chat:message', sys);
      });

      socket.on('chat:message', (data, cb) => {
        const user = users.get(socket.id);
        if (!user) return ack(cb, false, 'Not joined');
        if (mutedUsers.has(user.username.toLowerCase()))
          return ack(cb, false, 'You have been muted by the host');
        const { text } = data || {};
        if (!text || !text.trim()) return ack(cb, false, 'Message is empty');
        const msg = text.trim();
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

      socket.on('playback:control', (data, cb) => {
        const user = users.get(socket.id);
        if (!user || !user.isHost) return ack(cb, false, 'Only the host can control playback');
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

        io.emit('playback:control', {
          action,
          time: playbackState.currentTime,
          isPlaying: playbackState.isPlaying,
          timestamp: now,
          originator: socket.id,
        });
        ack(cb, true);
      });

      socket.on('video:duration', (data, cb) => {
        const user = users.get(socket.id);
        if (!user || !user.isHost) return ack(cb, false, 'Host only');
        const { duration } = data || {};
        if (typeof duration === 'number' && isFinite(duration)) playbackState.duration = duration;
        ack(cb, true);
      });

      // ---- host moderation ----
      socket.on('host:kick', (data, cb) => {
        const host = users.get(socket.id);
        if (!host || !host.isHost) return ack(cb, false, 'Only the host can do that');
        const targetId = data && data.targetId;
        const target = users.get(targetId);
        if (!target) return ack(cb, false, 'Participant not found');
        if (target.isHost) return ack(cb, false, 'You cannot remove yourself');
        const targetSocket = io.sockets.sockets.get(targetId);

        target.kicked = true;
        const sys = addChatMessage('system', `${escapeHtml(target.username)} was removed by the host`, 'system');
        io.emit('chat:message', sys);
        if (targetSocket) {
          targetSocket.emit('user:kicked', { message: 'You were removed from the session by the host.' });
          setTimeout(() => targetSocket.disconnect(true), 100);
        }
        ack(cb, true);
      });

      socket.on('host:mute', (data, cb) => {
        const host = users.get(socket.id);
        if (!host || !host.isHost) return ack(cb, false, 'Only the host can do that');
        const targetId = data && data.targetId;
        const target = users.get(targetId);
        if (!target) return ack(cb, false, 'Participant not found');
        if (target.isHost) return ack(cb, false, 'You cannot mute yourself');

        const key = target.username.toLowerCase();
        const shouldMute = !mutedUsers.has(key);
        if (shouldMute) mutedUsers.add(key); else mutedUsers.delete(key);

        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) targetSocket.emit('user:muted', { muted: shouldMute });
        io.emit('users:updated', { users: userListPayload() });
        const sys = addChatMessage('system', `${escapeHtml(target.username)} ${shouldMute ? 'was muted' : 'was unmuted'} by the host`, 'system');
        io.emit('chat:message', sys);
        ack(cb, true);
      });

      socket.on('disconnect', (reason) => {
        const user = users.get(socket.id);
        if (!user) return;
        users.delete(socket.id);
        console.log(`[session] ${user.username} disconnected (${reason})`);
        io.emit('user:left', { username: user.username, users: userListPayload() });
        // A kicked user already had a "was removed by the host" message emitted.
        if (!user.kicked) {
          const sys = addChatMessage('system', `${escapeHtml(user.username)} left the session`, 'system');
          io.emit('chat:message', sys);
        }
        // Transfer host role if the host left and others remain (the user:left
        // event was already emitted above — do not emit it a second time).
        if (user.isHost && users.size > 0) {
          const first = users.values().next().value;
          first.isHost = true;
          io.emit('users:updated', { users: userListPayload() });
        }
      });
    });

    const listenReady = new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '0.0.0.0', () => {
        srv.removeListener('error', reject);
        sessionServer = srv;
        sessionIo = io;
        sessionPort = port;
        sessionUrl = sessionBaseUrl(port);
        hostToken = crypto.randomBytes(16).toString('hex');
        console.log(`[session] listening on 0.0.0.0:${sessionPort} (${sessionUrl})`);
        resolve({ port, url: sessionUrl, hostToken });
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

bootstrapApp.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'setup.html'));
});

bootstrapApp.get('/api/status', (_req, res) => {
  res.json({
    running: !!sessionServer,
    port: sessionPort,
    url: sessionUrl,
    hostToken,
    ips: getLocalIPv4Addresses(),
    participants: sessionIo ? sessionIo.engine.clientsCount : 0,
    video: currentVideo ? { name: currentVideo.name, size: currentVideo.size } : null,
    error: sessionStartError,
  });
});

bootstrapApp.post('/api/start', async (req, res) => {
  if (sessionServer) return res.status(400).json({ error: 'Session server already running' });
  const { port } = req.body || {};
  const p = parseInt(port, 10);
  if (!p || p < 1024 || p > 65535)
    return res.status(400).json({ error: 'Invalid port (choose 1024-65535)' });
  try {
    const info = await startSessionServer(p);
    res.json({ ok: true, ...info });
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