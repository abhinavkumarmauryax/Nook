# Local Watch Together

A free, self-hosted watch-party app. One person hosts a server on their computer, picks a local video file, and everyone else joins from a browser to watch in sync and chat in real time.

No paid subscription, no cloud server, no database, no third-party streaming service, and no accounts. Video files never leave the host's machine.

## Features

- **Host setup page** — choose a port, start/stop the session server, see your LAN IP, join URL, status, and live participant count.
- **Local video selection** — the host picks a file from disk inside the Watch page. It is streamed with HTTP range requests, so seeking works without downloading the whole file. Large files are written to temporary disk storage, never held in memory.
- **Synchronized playback** — the host controls play, pause, seek, and video changes. New joiners automatically sync to the current position.
- **Real-time chat** — usernames, timestamps, emoji/Unicode, system join/leave messages, participant list, message-length limits, and rate limiting.
- **Host moderation** — mute/unmute or kick participants from the participant list. Muting blocks chat server-side and persists across reconnects.
- **Viewer settings** — everyone gets their own volume, mute, and fullscreen controls. Playback controls remain host-only.
- **Three screens** — Server Setup → Join Session → Watch Together, with a dark, responsive UI.
- **Portable build** — a single Windows `.exe` with the runtime bundled; no Node.js install needed to host.
- **Optional remote access** — Cloudflare Tunnel, ZeroTier, or Playit.gg (all optional; plain LAN use needs none of them).

## Tech stack

| Layer | Technology |
| --- | --- |
| Backend | Node.js 18+ and Express |
| Real-time | Socket.IO (WebSocket with long-polling fallback) |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Video | Native HTML5 `<video>` with HTTP range streaming |
| Storage | In-memory session state; temporary files for the selected video |

## Project structure

```
local-watch-together/
├── server.js                 # Bootstrap UI server + session server manager
├── package.json              # Dependencies and scripts
├── package-lock.json
├── start.bat                 # Windows: start from source
├── start.sh                  # Linux/macOS: start from source
├── README.md
├── LICENSE
├── .gitignore
└── public/
    ├── setup.html            # Screen 1: Server Setup
    ├── join.html             # Screen 2: Join Session
    ├── watch.html            # Screen 3: Watch Together
    ├── sample-test.mp4       # Small sample clip for the "Test Video" button
    ├── css/
    │   └── style.css
    └── js/
        ├── setup.js
        ├── join.js
        ├── watch.js
        └── socket.io.js      # Bundled client (so the .exe can serve it)
```

Generated at runtime and **not** committed: `node_modules/`, `watch-together.exe` (build output), and the system-temp upload folder.

## Quick start (portable exe — Windows x64)

1. Download `watch-together.exe` from the repository **Releases** page (or build it yourself below).
2. Double-click it. Leave the console window open.
3. Open <http://localhost:3000> in a browser.
4. Enter a port (default `3001`) and click **Start Server**.
5. Click **Open Watch Session (Host)**, enter a username, and click **Join**.
6. In the Watch page, click **📁 Select Video** to choose the file everyone will watch.
7. Share the Session URL shown on the setup page with people on the same network. They open it, enter a username, and join.

> Windows may warn about an unsigned executable on first run: **More info → Run anyway**.

## Running from source

Requirements: [Node.js](https://nodejs.org/) 18 or newer and a modern browser.

```bash
git clone <your-repo-url>
cd local-watch-together
npm install
npm start
```

Then open <http://localhost:3000>. On Windows you can also double-click `start.bat`; on Linux/macOS run `./start.sh`.

The setup UI port can be changed with the `PORT` environment variable, e.g. `PORT=4000 npm start`.

## Building the portable exe

```bash
npm run build
# produces watch-together.exe
```

The build uses `pkg` 5.8.1 and targets `node18-win-x64`. The `pkg` CLI is fetched automatically by the build script. The resulting exe bundles the Node runtime and everything in `public/`, so it runs on any Windows x64 machine without Node installed.

## Hosting a session

1. Start the app and open the setup page at <http://localhost:3000>.
2. Choose a TCP port (1024–65535) and click **Start Server**. The session server binds to `0.0.0.0`.
3. Note the **Session URL** (for example `http://192.168.1.42:3001`) and share it with participants.
4. Open the Watch page as host, enter a username, and pick a video with **📁 Select Video**.
5. Use the player controls to play, pause, or seek — everyone follows. Chat in the side panel.

### Host controls

| Control | Purpose |
| --- | --- |
| Start / Stop Server | Starts or stops the session server on the chosen port |
| Port | TCP port for the session server (1024–65535) |
| Session URL | Link participants open (append `/join`) |
| Open Watch Session (Host) | Opens the Watch page with host privileges |
| 📁 Select Video | Choose or replace the shared video at any time |
| Participants (toggle) | Show/hide the participant list in the chat panel |
| Mute / Unmute | Block or allow a participant's chat messages |
| Kick | Remove a participant from the session |

Participants keep their own volume, mute, and fullscreen controls. Play/pause and seeking are host-only, and their play/pause button is hidden.

## Joining a session

1. Be on the same Wi-Fi/network as the host (or use one of the remote-access options below).
2. Open the Session URL, for example `http://192.168.1.42:3001/join`.
3. Enter a username (2–32 characters, letters/numbers/space/`_`/`.`/`-`) and click **Join**.
4. You will see the shared video and chat. New joiners start at the host's current playback position.

Usernames are case-insensitive and must be unique in a session.

## Public / remote access (optional)

Local-network use needs no external service. If people are on different networks, use one of these:

### Cloudflare Tunnel (recommended — free, no account)

```bash
cloudflared.exe tunnel --url http://localhost:3001
```

Share the printed `https://<random-name>.trycloudflare.com/join` URL. It supports WebSockets and HTTP, so sync and chat work unchanged. Leave the tunnel running for the whole session. The quick-tunnel URL changes on restart; a permanent one requires a Cloudflare account and domain.

> **Never expose port 3000** — that is the host setup page and reveals the host token and start/stop controls. Only tunnel the session port (3001 by default).

### ZeroTier (free, private virtual LAN)

Install the ZeroTier client on the host and every participant, join the same free network, authorize the devices, and share `http://<host-zerotier-ip>:3001/join`. Allow inbound TCP on the chosen port in the host firewall.

### Playit.gg (optional)

This app needs a **TCP** tunnel — HTTP, video streaming, and WebSockets all run over TCP. Playit's free UDP tunnels cannot carry a browser app. Their site currently marks custom TCP tunnels as Premium (~$3/month), so check current pricing. If you use it, create a TCP tunnel to local port 3001 and share `http://<public-address>/join`.

Note that every viewer streams the video from your upload bandwidth, so a fast upload connection matters more when playing over the internet.

## Troubleshooting

| Problem | Likely cause / fix |
| --- | --- |
| "Port unavailable" | Another app is using the port. Pick a different one (3002, 8080) and restart. |
| Participants cannot reach the URL | Make sure devices are on the same network and AP/client isolation is off. Use the host's LAN IP, not `localhost`. |
| Cannot connect but ping works | Host firewall is blocking the port. Allow inbound TCP on the chosen port. |
| Video will not play | Use MP4/WebM/OGG/MOV with a browser-supported codec (H.264/AAC in MP4 works). Check the on-screen error overlay. |
| Seeking does not work | The server supports HTTP range requests. Refresh the page and retry. |
| Playback drifts out of sync | Host can pause and resume to realign everyone. |
| Username already taken | Usernames are case-insensitive. Try another name. |
| Host cannot control playback | Open the Watch page through **Open Watch Session (Host)**. |
| Where do uploaded videos go? | The selected file is copied to a temporary folder under the system temp directory and removed when it is replaced or the server stops. |

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port for the setup UI |
| `MAX_VIDEO_SIZE_GB` | `2` | Maximum selected video size |

Example: `PORT=4000 MAX_VIDEO_SIZE_GB=5 npm start`

## Security notes

- Designed for trusted networks; anyone with the join URL can enter (there is no join password).
- Usernames and chat messages are validated and HTML-escaped before display.
- The streaming endpoint only serves the currently selected video — no filesystem access.
- Host-only actions (playback, mute, kick) are enforced on the server.
- Never expose the setup UI (port 3000) to untrusted networks.

## Contributing

Pull requests are welcome. Please open an issue first for larger changes. To run locally: `npm install && npm start`.

## License

MIT — see [LICENSE](LICENSE).
