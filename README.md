# Nook

<p align="center"><img src="public/assets/nook-logo.svg" alt="Nook logo" width="140"></p>

A free, self-hosted watch-party app. One person hosts a server on their computer, picks a local video file or shares a direct video URL, and everyone else joins from a browser to watch in sync and chat in real time.

No paid subscription, no cloud server, no database, no third-party streaming service, and no accounts. Local video files never leave the host's machine.

> **Licensing:** source-available, non-commercial and contribution-only. Viewing, studying, personal evaluation and submitting contributions are allowed; independent redistribution and commercial use are not. See [LICENSE](LICENSE).

## Features

- **Host setup page** — choose a port, start/stop the session server, see your LAN IP, join URL, chat URL, status, and participant count.
- **Local video or video URL** — the owner picks a file from disk or pastes a direct MP4/WebM/HLS URL. Local files are streamed with HTTP range requests (seeking works) and written to temp disk, never held in memory.
- **Synchronized playback** — only the owner can play, pause, seek or change the video. New joiners sync to the current position.
- **Three permission levels** — owner, admin, and member. Admins can mute/kick regular members; only the owner manages admins and playback.
- **Host transfer** — the owner can hand ownership to another participant, who must accept before the transfer happens.
- **Real-time chat** — usernames, timestamps, emoji, system messages, length limits, and rate limiting. Muted members cannot chat.
- **Standalone pop-out chat** — `/chat` opens a compact chat-only page authenticated by the joined session.
- **Resizable, hideable chat panel** — drag the divider to resize; hide/show with a button; width persists in local storage.
- **Dark theme with custom scrollbars** across chat, participant list, modals and other scrollable areas.
- **Portable Windows exe** — single file with the runtime bundled.
- **Optional remote access** — Cloudflare Tunnel, ZeroTier, or Playit.gg.

## Tech stack

| Layer | Technology |
| --- | --- |
| Backend | Node.js 18+ and Express |
| Real-time | Socket.IO (WebSocket with long-polling fallback) |
| Frontend | Vanilla HTML/CSS/JS |
| Video | Native HTML5 `<video>`, HTTP range streaming, HLS.js for `.m3u8` |
| Storage | In-memory session state; temporary files for local video |

## Project structure

```
nook/
├── server.js                 # Bootstrap UI + session server + permissions
├── package.json
├── package-lock.json
├── start.bat / start.sh
├── README.md / LICENSE / .gitignore / .gitattributes
├── .github/workflows/        # Builds the exe on tagged releases
└── public/
    ├── setup.html / join.html / watch.html / chat.html
    ├── css/style.css
    └── js/
        ├── socket.io.js      # bundled client (works inside the exe)
        ├── hls.min.js        # HLS.js for .m3u8 streams
        ├── modal.js
        ├── setup.js / join.js / watch.js / chat.js
```

## Quick start (portable exe — Windows x64)

1. Download `nook.exe` from the repository **Releases** page.
2. Double-click it. Leave the console window open.
3. Open <http://localhost:3000>.
4. Start the server on a port (default `3001`).
5. Click **Open Watch Session (Host)**, enter a username, and join.
6. Use **📁 Select Video** or **🔗 Video URL** in the player to choose what everyone watches.
7. Share the Session URL with people on the same network: `http://<host-ip>:3001/join`.

> Windows may warn about an unsigned executable: **More info → Run anyway**.

## Running from source

```bash
git clone https://github.com/abhinavkumarmauryax/Nook.git
cd Nook
npm install
npm start
```

Then open <http://localhost:3000>. `PORT=4000 npm start` changes the setup UI port. Build the exe with `npm run build` (uses `pkg` 5.8.1, target `node18-win-x64`).

## Roles and permissions

| Action | Owner | Admin | Member |
| --- | --- | --- | --- |
| Play / pause / seek / change video | ✅ | ❌ | ❌ |
| Upload local file / set video URL | ✅ | ❌ | ❌ |
| Mute, unmute, kick members | ✅ | ✅ | ❌ |
| Mute/kick admins | ✅ | ❌ | ❌ |
| Promote / demote admins | ✅ | ❌ | ❌ |
| Transfer ownership | ✅ | ❌ | ❌ |
| Chat (unless muted) | ✅ | ✅ | ✅ |

All checks are enforced on the server. Hidden buttons are only a convenience. The owner can never be muted or kicked. Only one owner exists at a time; if the owner leaves without transferring, someone is promoted automatically after a short grace period.

## Chat and participants

- The **💬 Hide Chat / Show Chat** button collapses the chat panel and gives the video more room. Messages and chat delivery continue while hidden.
- Drag the divider between video and chat to resize the panel (desktop only). The width is saved locally.
- **↗ Pop Out Chat** opens `/chat` in a new tab. It reuses your joined session, so no username prompt appears. Direct access to `/chat` without an active session shows an access-denied page.
- The participant toggle in the chat panel shows/hides the participant list. Role badges and muted indicators appear next to names.

## Public / remote access (optional)

Local-network use needs no external service.

### Cloudflare Tunnel (free, no account)

```
cloudflared.exe tunnel --url http://localhost:3001
```

Share the printed `https://<name>.trycloudflare.com/join` URL. Leave the tunnel running. **Never expose port 3000** — that is the host setup page.

### ZeroTier (free, private virtual LAN)

Install ZeroTier on the host and participants, join the same network, authorize devices, and share `http://<host-zerotier-ip>:3001/join`. Allow inbound TCP 3001 in the host firewall.

### Playit.gg

This app needs a **TCP** tunnel (HTTP/WebSocket). Playit's free UDP tunnels cannot carry a browser app, and custom TCP tunnels currently require Premium. If you use it, create a TCP tunnel to local port 3001.

## Troubleshooting

| Problem | Likely cause / fix |
| --- | --- |
| "Port unavailable" | Another app uses the port. Choose another (3002, 8080). |
| Participants cannot connect | Same network required; disable AP/client isolation; use the host's IP, not `localhost`. |
| Firewall blocking | Allow inbound TCP on the chosen session port. |
| Video will not play | Use a direct MP4/WebM/HLS URL or a supported local file. Generic webpage URLs (YouTube, Netflix) are not supported. |
| Chat says "You have been muted" | A moderator muted you; ask them to unmute. |
| Pop-out chat is denied | Open it from the Pop Out Chat button while joined, or rejoin the session. |
| Playback will not change | Only the owner can control playback. |

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Setup UI port |
| `MAX_VIDEO_SIZE_GB` | `2` | Maximum local video size |

## Security notes

- Intended for trusted networks; anyone with the join URL can enter (no join password).
- Usernames and chat messages are validated and HTML-escaped.
- The streaming endpoint only serves the currently selected local video.
- Video URLs are validated (HTTP/HTTPS only, no embedded credentials, no loopback/internal addresses). The server never proxies or fetches the URL — browsers load it directly.
- Owner-only actions are enforced server-side. Session tokens bind the pop-out chat to the joined participant.

## License

This project is **source-available, non-commercial and contribution-only**. It is **not** an open-source licence and does not permit independent distribution or commercial use.

See [LICENSE](LICENSE) for the full terms, and [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution process and the [Contributor Agreement](CONTRIBUTOR_AGREEMENT.md) required before a contribution is merged.

Earlier versions were published under the MIT Licence. Section 2 of the current licence preserves the MIT permissions already granted for those earlier versions; it does not revoke them.
