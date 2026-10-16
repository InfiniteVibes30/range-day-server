/*
 * Range Day online relay.
 *
 * One process serves the game page over HTTP and runs WebSocket rooms on the same port.
 * The server is a relay, not a simulation: every client simulates its own soldier and
 * reports it ~20 times a second; the server forwards those reports to the rest of the room.
 * The server owns what everyone must agree on:
 *   - who is in a room, who hosts it, and which team each player is on
 *   - the bot roster: bots fill the teams up to the host's chosen size and are added or
 *     removed as people join and leave, so the sides stay even. The host's game runs the bots.
 *   - when a match starts (one clock for everyone) and its settings (mode, map, seed, limits)
 *   - kills, deaths and team score (late joiners get the current scoreboard and objectives)
 * Hits are routed only to whoever simulates the soldier that was hit (the player themselves,
 * or the host for a bot); that game applies the damage and announces the death.
 *
 *   npm install
 *   node server.js            (PORT=8080 by default)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const MAX_PLAYERS = 12;
const MAX_BOTS_PER_SIDE = 8;
const WARMUP_MS = 6000;
const MODES = {
  tdm: { teams: true, time: 600, score: 50, respawn: 4 },
  ffa: { teams: false, time: 600, score: 30, respawn: 3 },
  gun: { teams: false, time: 600, score: 8, respawn: 2 },
  ctf: { teams: true, time: 600, score: 3, respawn: 5 },
  dom: { teams: true, time: 600, score: 150, respawn: 4 },
};
const DIFFICULTIES = ['recruit', 'regular', 'hardened', 'veteran'];
const BOT_NAMES = ['Harper', 'Okafor', 'Lindqvist', 'Reyes', 'Volkov', 'Tanaka', 'Mbeki', 'Castillo', 'Novak', 'Ibarra', 'Kowalski', 'Moreau', 'Adeyemi', 'Sato', 'Brennan',
  'Haddad', 'Varga', 'Quinn', 'Petrov', 'Okoye', 'Delgado', 'Sorensen', 'Achebe', 'Ruiz', 'Fischer', 'Nakamura', 'Doyle', 'Kaur', 'Mendez', 'Abara', 'Larsen', 'Costa'];
// the game page: ./public/index.html when deployed, else the online build next to this folder
const GAME_FILES = [
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, '..', 'range_day v17 online.html'),
];

// ------------------------------------------------------------------ http
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    const file = GAME_FILES.find(f => fs.existsSync(f));
    if (!file) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Game page not found. Put the game at public/index.html.'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res); return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
});

// ------------------------------------------------------------------ rooms
const rooms = new Map();          // code -> room
let nextId = 1;

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = { code, players: new Map(), bots: new Map(), host: 0, match: null, score: { A: 0, B: 0 }, obj: null, endTimer: null, endQueued: false }; rooms.set(code, r); }
  return r;
}
const pub = p => ({ id: p.id, name: p.name, look: p.look, team: p.team, kills: p.kills, deaths: p.deaths, bot: p.bot || undefined, gun: p.gun });
const send = (p, o) => { if (p.ws && p.ws.readyState === 1) p.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); };
function broadcast(room, o, except = 0) { const s = JSON.stringify(o); for (const p of room.players.values()) if (p.id !== except) send(p, s); }
const everyone = room => [...room.players.values(), ...room.bots.values()];
const member = (room, id) => room.players.get(id) || room.bots.get(id) || null;
const scores = room => ({ score: room.score, obj: room.obj, board: everyone(room).map(p => ({ id: p.id, kills: p.kills, deaths: p.deaths })) });
const teamsOn = room => room.match && MODES[room.match.cfg.mode].teams;

// ------------------------------------------------------------------ bots
function addBot(room, team) {
  const used = new Set([...room.bots.values()].map(b => b.name));
  const name = BOT_NAMES.find(n => !used.has(n)) || 'Bot ' + nextId;
  const b = { id: nextId++, bot: true, name, team, gun: (Math.random() * 1000) | 0, kills: 0, deaths: 0, look: null };
  if (!team) b.team = 'F' + b.id;
  room.bots.set(b.id, b);
  return b;
}
/**
 * Keep the sides even: each team is topped up with bots to the chosen size (or to the bigger human
 * side, whichever is larger), and bots step aside as people join. Free-for-all fills to twice the size.
 * Returns the bots added and removed so callers can tell the room.
 */
function rebalance(room) {
  const added = [], removed = [];
  const fill = room.match ? room.match.cfg.bots : 0;
  const drop = b => { room.bots.delete(b.id); removed.push(b.id); };
  if (!room.match) return { added, removed };
  if (teamsOn(room)) {
    const humans = t => [...room.players.values()].filter(p => p.team === t).length;
    const target = Math.max(fill, humans('A'), humans('B'));
    for (const t of ['A', 'B']) {
      const bots = () => [...room.bots.values()].filter(b => b.team === t);
      while (humans(t) + bots().length < target && bots().length < MAX_BOTS_PER_SIDE) added.push(addBot(room, t));
      while (humans(t) + bots().length > target && bots().length) drop(bots().pop());
    }
  } else {
    const target = Math.max(fill * 2, room.players.size);
    while (room.players.size + room.bots.size < target && room.bots.size < MAX_BOTS_PER_SIDE * 2) added.push(addBot(room, null));
    while (room.players.size + room.bots.size > target && room.bots.size) drop([...room.bots.values()].pop());
  }
  return { added, removed };
}
function announceRoster(room, { added, removed }) {
  for (const id of removed) broadcast(room, { t: 'peer-', id });
  for (const b of added) broadcast(room, { t: 'peer+', p: pub(b) });
}

/** Team for a player joining a match: the side with fewer people (then fewer soldiers), or their own in free-for-all. */
function teamFor(room, p) {
  if (!room.match) return null;
  if (!teamsOn(room)) return 'F' + p.id;
  const count = (t, list) => list.filter(o => o !== p && o.team === t).length, hum = [...room.players.values()], all = everyone(room);
  const ha = count('A', hum), hb = count('B', hum);
  if (ha !== hb) return ha < hb ? 'A' : 'B';
  return count('A', all) <= count('B', all) ? 'A' : 'B';
}

// ------------------------------------------------------------------ match flow
function startMatch(room, req) {
  const mode = MODES[req.mode] ? req.mode : 'tdm', M = MODES[mode];
  const time = Math.max(60, Math.min(1800, (+req.time | 0) || M.time));
  const score = mode === 'gun' ? M.score : Math.max(1, Math.min(500, (+req.score | 0) || M.score));
  const map = typeof req.map === 'string' ? req.map.slice(0, 32) : 'random';
  const bots = Math.max(0, Math.min(MAX_BOTS_PER_SIDE, req.bots | 0));
  const difficulty = DIFFICULTIES.includes(req.difficulty) ? req.difficulty : 'regular';
  const now = Date.now();
  room.match = { cfg: { mode, map, time, score, respawn: M.respawn, friendlyFire: false, bots, difficulty }, seed: 1 + ((Math.random() * 9999) | 0), startAt: now + WARMUP_MS };
  room.score = { A: 0, B: 0 }; room.obj = null; room.endQueued = false; room.bots.clear();
  // fresh, balanced teams in join order, then bots to even them out
  let i = 0; for (const p of room.players.values()) { p.kills = 0; p.deaths = 0; p.team = M.teams ? (i++ % 2 ? 'B' : 'A') : 'F' + p.id; }
  rebalance(room);
  clearTimeout(room.endTimer);
  room.endTimer = setTimeout(() => endMatch(room, 'Time limit reached'), WARMUP_MS + time * 1000 + 1500);
  broadcast(room, { t: 'match', match: room.match, now, players: everyone(room).map(pub) });
  log(room, `match started: ${mode} on ${map}, ${room.players.size} players + ${room.bots.size} bots`);
}

function endMatch(room, reason) {
  if (!room.match) return;
  clearTimeout(room.endTimer); room.endTimer = null;
  room.match = null;
  broadcast(room, Object.assign({ t: 'over', reason }, scores(room)));
  room.bots.clear();
  log(room, `match over: ${reason}`);
}
function queueEnd(room, reason) { if (room.endQueued) return; room.endQueued = true; setTimeout(() => endMatch(room, reason), 3000); }

function onDeath(room, victim, m) {
  if (!room.match || Date.now() < room.match.startAt) return;
  const killer = member(room, m.by | 0), mode = room.match.cfg.mode;
  victim.deaths++;
  const valid = killer && killer !== victim && killer.team !== victim.team;
  if (valid) killer.kills++;
  if (mode === 'tdm' && (victim.team === 'A' || victim.team === 'B')) room.score[victim.team === 'A' ? 'B' : 'A']++;   // every death scores for the other side
  broadcast(room, { t: 'died', from: victim.id, by: killer ? killer.id : 0, w: String(m.w || '').slice(0, 32), head: !!m.head, l: m.l | 0, at: Array.isArray(m.at) ? m.at.slice(0, 3) : null }, victim.bot ? room.host : victim.id);
  const limit = room.match.cfg.score;
  if (mode === 'tdm' && (room.score.A >= limit || room.score.B >= limit)) queueEnd(room, 'Score limit reached');
  if (mode === 'ffa' && valid && killer.kills >= limit) queueEnd(room, 'Kill limit reached');
}

/** Hand hosting (and with it the bots and objectives) to someone whose game is in front, if there is one. */
function rehost(room, except = null) {
  const list = [...room.players.values()].filter(o => o !== except);
  const next = list.find(o => !o.away) || list[0];
  if (!next) { room.host = 0; return; }
  if (next.id === room.host) return;
  room.host = next.id; broadcast(room, { t: 'host', id: next.id });
}

function leave(p) {
  const room = p.room; if (!room) return;
  room.players.delete(p.id); p.room = null;
  broadcast(room, { t: 'peer-', id: p.id });
  if (room.host === p.id) rehost(room);
  if (!room.players.size) { clearTimeout(room.endTimer); rooms.delete(room.code); }
  else if (room.match) announceRoster(room, rebalance(room));                 // a bot takes the empty slot
  log(room, `${p.name} left (${room.players.size} left)`);
}

function log(room, msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] room ${room.code}: ${msg}`); }

// ------------------------------------------------------------------ sockets
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
wss.on('connection', ws => {
  const p = ws.player = { id: nextId++, ws, name: 'Player', look: null, team: null, kills: 0, deaths: 0, room: null, alive: true };
  ws.on('pong', () => { p.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = p.room;
    switch (m.t) {
      case 'join': {
        if (room) return;
        const code = String(m.room || 'RANGE').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12) || 'RANGE';
        const r = getRoom(code);
        if (r.players.size >= MAX_PLAYERS) { send(p, { t: 'err', msg: `Room ${code} is full (${MAX_PLAYERS} players)` }); return; }
        p.name = String(m.name || 'Player').replace(/[<>&"]/g, '').trim().slice(0, 16) || 'Player';
        p.look = m.look && typeof m.look === 'object' && JSON.stringify(m.look).length < 2000 ? m.look : null;
        p.kills = 0; p.deaths = 0;
        p.room = r; r.players.set(p.id, p); if (!r.host) r.host = p.id;
        p.team = teamFor(r, p);
        const roster = rebalance(r);                                      // a bot steps aside for the newcomer
        send(p, Object.assign({ t: 'welcome', id: p.id, room: code, host: r.host, players: everyone(r).map(pub), match: r.match, now: Date.now() }, scores(r)));
        for (const id of roster.removed) broadcast(r, { t: 'peer-', id }, p.id);
        broadcast(r, { t: 'peer+', p: pub(p) }, p.id);
        for (const b of roster.added) broadcast(r, { t: 'peer+', p: pub(b) }, p.id);
        const h = r.players.get(r.host); if (h && h.away && h !== p) { r.host = p.id; broadcast(r, { t: 'host', id: p.id }); }     // the host is tabbed out: take over
        log(r, `${p.name} joined (${r.players.size} players, ${r.bots.size} bots)`);
        return;
      }
      case 'ping': send(p, { t: 'pong', c: m.c, s: Date.now() }); return;
    }
    if (!room) return;
    const isHost = room.host === p.id;
    // the host speaks for the bots: `as` names the bot a message is about
    const as = m.as != null ? room.bots.get(m.as | 0) : null;
    if (m.as != null && (!as || !isHost)) return;
    const self = as || p;
    switch (m.t) {
      case 'start':                                                     // host only
        if (isHost && !room.match) startMatch(room, m);
        return;
      case 'end':                                                       // host's game says the match is over
        if (isHost && room.match && Date.now() > room.match.startAt) queueEnd(room, String(m.reason || 'Match over').slice(0, 40));
        return;
      case 's': case 'shot': case 'proj':                                // relay to everyone else
        if (!room.match) return;
        m.from = self.id; delete m.as; broadcast(room, m, p.id);
        return;
      case 'bs': case 'obj': case 'oev':                                 // bot snapshots and objective state: host only
        if (!room.match || !isHost) return;
        if (m.t === 'obj') { room.obj = m; if (m.sc && teamsOn(room)) room.score = { A: m.sc.A | 0, B: m.sc.B | 0 }; }
        m.from = p.id; broadcast(room, m, p.id);
        return;
      case 'hit': {                                                      // route to whoever simulates the soldier that was hit
        if (!room.match) return;
        const target = member(room, m.to | 0); if (!target || target === self) return;
        const dest = target.bot ? room.players.get(room.host) : target; if (!dest || dest === p) return;     // the host applies its own bots' hits locally
        send(dest, { t: 'hit', from: self.id, to: target.id, amt: Math.max(0, Math.min(500, +m.amt || 0)), head: !!m.head, w: String(m.w || '').slice(0, 32), o: Array.isArray(m.o) ? m.o.slice(0, 3) : null });
        return;
      }
      case 'died': onDeath(room, self, m); return;
      case 'sync': send(p, Object.assign({ t: 'board' }, scores(room))); return;     // current scoreboard (joining a match in progress)
      // a hidden browser tab stops running the game, so a host who tabs out hands the bots to someone else
      case 'away': p.away = true; if (isHost) rehost(room); return;
      case 'back': { p.away = false; const h = room.players.get(room.host); if (!h || h.away) { room.host = p.id; broadcast(room, { t: 'host', id: p.id }); } return; }
      case 'leave': leave(p); return;
    }
  });
  ws.on('close', () => leave(p));
  ws.on('error', () => {});
});
// drop dead connections
setInterval(() => { for (const ws of wss.clients) { const p = ws.player; if (!p.alive) { ws.terminate(); continue; } p.alive = false; try { ws.ping(); } catch (e) {} } }, 15000);

server.listen(PORT, () => {
  console.log(`Range Day server on port ${PORT}`);
  console.log(`  this computer:      http://localhost:${PORT}`);
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  same Wi-Fi / LAN:   http://${a.address}:${PORT}`);
});
