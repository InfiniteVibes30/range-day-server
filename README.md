# Range Day online server

Real-time multiplayer for Range Day: a small Node.js WebSocket relay. It serves the game page and runs rooms on one port.

- Modes: Team Deathmatch, Free-for-All, Gun Game, Capture the Flag and Domination, up to 12 players per room
- Bots: the host picks a team size (Off, or Fill to 2 v 2 up to 6 v 6) and a bot difficulty. Bots fill the empty slots and keep the sides even. When someone joins, a bot on the short side steps aside. When someone leaves, a bot takes their place. In Free-for-All and Gun Game, bots fill up to twice the chosen size. To make online matches people-only later, set the Bots option to Off, or force `bots` to `0` in `startMatch` in `server.js`
- Each player's game simulates their own soldier and sends its position 20 times a second; other players appear as soldiers wearing their own character look
- The host's game runs the bots and the objectives (flags and capture zones) and sends their state to everyone. A hidden or minimized browser pauses the game, so when the host tabs out, hosting moves to another player who is still playing, and that player picks up where the bots and objectives left off
- Whoever simulates a soldier decides its damage. Hits are sent to that soldier's player, or to the host for a bot. That game applies the damage and announces the death
- The server keeps one match clock and the kills, deaths and team score, so players who join late see the right scoreboard and objective state
- Your classes, character and XP work online. Killstreaks are off in online matches

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd range-day-server
npm install
node server.js
```

Keep that window open while you play; closing it stops the server. (`npm start` does the same, but Windows PowerShell blocks `npm` when script running is disabled, so use `node server.js` there, or `npm.cmd install` for the install step.)

The server prints its addresses:

```
Range Day server on port 8080
  this computer:      http://localhost:8080
  same Wi-Fi / LAN:   http://10.0.0.199:8080
```

Open that address in a browser. The server sends `range_day v17 online.html` from the folder above it. In the game, go to **Online**, check the server address, enter a name and room code, and click **Connect**.
The first player in a room is the host. The host picks the mode, map and time limit, then clicks **Start match**.

## Playing with friends

**Same Wi-Fi or LAN:** each friend opens `http://<your LAN address>:8080`. The first time, Windows may ask whether to let Node.js through the firewall. Allow it on private networks.

**Over the internet, quick option (tunnel):** keep the server running and, in a second terminal, run:

```bash
npx cloudflared tunnel --url http://localhost:8080
```

It prints an `https://….trycloudflare.com` address. Friends open that address and click Connect, since the address is already filled in.

**Over the internet, always on (free hosting):** deploy this folder to a Node host such as Render, Railway or Fly.io:

1. Copy `range_day v17 online.html` to `range-day-server/public/index.html`, so the server can find it without the parent folder.
2. Push `range-day-server` to a GitHub repo and create a **Web Service** from it. Use `npm install` as the build command and `npm start` as the start command. The host sets `PORT` automatically.
3. Everyone opens the service URL, for example `https://range-day.onrender.com`.

If someone opens the game file directly from disk instead, they type the host name, such as `range-day.onrender.com`, into the **Server** field. The game uses `wss://` for public host names and `ws://` for `localhost`, IP addresses and addresses with an explicit port.

## Testing alone

`test-bot.js` joins a room as a fake player:

```bash
node test-bot.js ws://localhost:8080 RANGE TestBot
```

It walks in a circle and fires tracers. With `TEST_FRONT=1` it stands 2.5 m in front of you. With `TEST_SHOOT=1` it hits you for 34 damage every 2 seconds.

Open the game with `?debug` (for example `http://localhost:8080/?debug`) to get `RD.game` and `RD.net` in the browser console.

## Protocol (JSON over one WebSocket)

| Client → server | |
|---|---|
| `join {room, name, look}` | enter a room (the server answers `welcome`) |
| `start {mode, map, time, score}` | host only: start a match for the room |
| `s {p, v, y, pi, st, a, l, gm, r}` | your snapshot: position, velocity, yaw, pitch, stance, alive, life count, gun model, reloading |
| `shot {m, d, k, q}` | you fired (muzzle, direction, sound, suppressed), for tracers and sound |
| `proj {k, p, v, age, fuse}` | you launched a rocket, grenade or arrow |
| `hit {to, amt, head, w, o}` | your shot hit player `to` |
| `died {by, w, head, l, at}` | you died (sent by the victim) |
| `bs {b:[[id, x,y,z, vx,vy,vz, yaw, pitch, stance, alive, life, gun, reloading]…]}` | host only: snapshots of the bots it runs |
| `obj {sc, f \| pt, caps}`, `oev {k, key, what, by}` | host only: flag or zone state and objective events (taken, captured, returned…) |
| `as: <bot id>` on `shot`, `proj`, `hit`, `died` | host only: the message is about one of its bots |
| `away`, `back` | your game stopped or resumed running (tabbed out); the server moves hosting |
| `sync`, `ping`, `leave`, `end` | scoreboard request, clock sync, leave the room, host's match is over |

The server relays `s`, `shot` and `proj` to the rest of the room. It sends `hit` only to the target. It tallies `died` and broadcasts it, and it sends `peer+`, `peer-`, `host`, `match`, `over`, `board` and `pong`.

This design has one known limit. The server does not check hits, because each shooter reports their own, so a modified client could cheat. That is fine for friends. For public matchmaking you would move hit checks to the server.
