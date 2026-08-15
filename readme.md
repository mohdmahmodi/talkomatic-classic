<div align="center">

<img src="public/images/icons/favicon.png" alt="Talkomatic" width="90" />

# Talkomatic Classic

**The world's first chat room, reborn.** Real-time, character-by-character chat where everyone sees you type as you type, just like the original 1973 PLATO system.

[![Live Site](https://img.shields.io/website?url=https%3A%2F%2Fclassic.talkomatic.co%2Fhealthz&up_message=online&down_message=offline&label=classic.talkomatic.co)](https://classic.talkomatic.co/)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue)](license)
[![Docker Ready](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff9800)](contributing.md)

[**Try it live**](https://classic.talkomatic.co/) · [Report a bug](https://github.com/mohdmahmodi/talkomatic-classic/issues) · [Discord](https://discord.gg/N7tJznESrE)

</div>

---

## What is this?

Talkomatic was created in 1973 on the PLATO system at the University of Illinois. It was the first multi-user chat room ever built. This project is a faithful modern remake: no message log, no send button. Each person gets a section of the screen and everyone watches everyone else type live, letter by letter.

## Features

- **Live typing**: characters appear for everyone the moment you press them
- **Rooms**: public, semi-private (6-digit access code), and private, in horizontal or vertical layouts
- **Community suggestion board**: post ideas, reply, upvote, and see what gets approved and shipped
- **Discord avatars**: optionally show your Discord profile picture next to your name
- **Built-in apps**: collaborative jigsaw puzzle (with server-side image safety scanning), a shared piano, and a collaborative whiteboard
- **Themes**: swappable full-page themes, plus community themes
- **Moderation**: staff dashboard with audit log, reports, appeals, IP bans, and a word filter
- **Bot API**: token-based access for bots, with REST and Socket.IO

## Tech

Node.js, Express, and Socket.IO on the server. Vanilla JavaScript on the client with no build step and no framework. State persists to plain JSON files, so there is no database to run.

## Quick start

Requires Node.js 18 or newer.

```bash
git clone https://github.com/mohdmahmodi/talkomatic-classic.git
cd talkomatic-classic
npm install
npm start
```

Open `http://localhost:3000` and you are chatting.

## Configuration

Everything works with zero configuration. To customize, copy `.env.example` to `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | random per boot | Set this in production so sessions survive restarts |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `ALLOWED_ORIGINS` | none | Comma-separated public URLs of your instance. Required when deploying on your own domain |
| `DATA_DIR` | repo root | Where runtime JSON state is written |
| `TRUST_PROXY` | `1` | Reverse-proxy hops to trust. Set `0` if exposed directly |
| `DEV_KEY_HASH` | none | SHA-256 hash of the owner dev key |

## Deploying

### Docker Compose

```bash
docker compose up -d --build
```

The container listens on port 3000, binds `0.0.0.0`, and keeps all runtime state in a volume mounted at `/app/data`.

### Dokploy

1. Create an Application pointing at this repository and set the build type to **Dockerfile**.
2. Set environment variables: `SESSION_SECRET` (generate with `openssl rand -hex 32`) and `ALLOWED_ORIGINS` (the URL you will serve the app at, for example `https://chat.example.com`).
3. Add a volume mount for `/app/data` so rooms, bans, and identity data survive redeploys.
4. Point your domain at container port 3000. Dokploy's Traefik proxy handles HTTPS and the server already trusts one proxy hop.

### Monitoring

The live status page for the official instance is at [status.talkomatic.co](https://status.talkomatic.co).
Three public endpoints are made for uptime monitors like Uptime Kuma:

| Endpoint | Purpose | Suggested check |
| --- | --- | --- |
| `/healthz` | Liveness | HTTP 200 |
| `/api/v1/health` | Detailed health with subsystems | keyword `"status":"ok"` |
| `/api/v1/status` | Public stats for a status page | keyword `"status":"online"` |

## Contributing

Issues and pull requests are welcome. Read the [contributing guide](contributing.md) and the [code of conduct](CODE_OF_CONDUCT.md) first. If you want to suggest a feature as a user, the in-app Suggestion Board in the lobby is the fastest way to reach us.

## License

[MIT](license)

## Credits

Built and maintained by [Mohd Mahmodi](https://mohdmahmodi.com) ([@mohdmahmodi](https://x.com/mohdmahmodi)) with the Talkomatic community. Inspired by the original Talkomatic by Doug Brown and David R. Woolley (PLATO, 1973).
