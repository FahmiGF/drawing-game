/**
 * Server game tebak gambar: Express (static) + Socket.IO (realtime).
 * Jalankan: node server/server.js  (default port 3000)
 */
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { Room, MIN_PLAYERS, MAX_PLAYERS, RECONNECT_GRACE_MS } = require("./game");
const { listThemes } = require("./words");

const PORT = process.env.PORT || 3000;
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX = 15;
const DRAW_MAX = 400; // paket gambar per 5 detik

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "..", "public")));

const rooms = new Map();

// Durasi permainan bisa dipercepat lewat env (dipakai uji end-to-end).
const timings = {};
for (const [envKey, key] of [
  ["CHOOSE_MS", "chooseMs"],
  ["TURN_END_MS", "turnEndMs"],
  ["ROUND_END_MS", "roundEndMs"],
  ["TICK_MS", "tickMs"],
]) {
  const value = Number(process.env[envKey]);
  if (Number.isFinite(value) && value > 0) timings[key] = value;
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error("Gagal membuat kode room");
}

function addSystem(room, text) {
  const msg = { id: `${Date.now()}-${Math.random()}`, from: null, name: "Sistem", text, kind: "system", ts: Date.now() };
  room.messages.push(msg);
  if (room.messages.length > 100) room.messages.shift();
  io.to(room.code).emit("chat", msg);
}

function broadcastState(room) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.roomCode === room.code && socket.data.playerId) {
      socket.emit("roomState", room.stateFor(socket.data.playerId));
    }
  }
}

function getRoomState(room, socket) {
  return room.stateFor(socket.data.playerId);
}

function roomHooks(room) {
  return {
    broadcastState: () => broadcastState(room),
    emit: (event, payload) => io.to(room.code).emit(event, payload),
  };
}

function createRoom() {
  const code = makeCode();
  const room = new Room(code, { timings });
  room.hooks = roomHooks(room);
  rooms.set(code, room);
  return room;
}

function rateOk(socket, key, limit) {
  const now = Date.now();
  const bag = socket.data.rate || (socket.data.rate = {});
  const slot = bag[key] || (bag[key] = { count: 0, start: now });
  if (now - slot.start > CHAT_WINDOW_MS) {
    slot.count = 0;
    slot.start = now;
  }
  slot.count += 1;
  return slot.count <= limit;
}

function joinAs(socket, room, name) {
  const reclaimed = room.reclaim(name);
  let player;
  if (reclaimed) {
    player = reclaimed;
  } else {
    const added = room.addPlayer(name);
    if (added.error) return { error: added.error };
    player = added.player;
  }
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);

  socket.emit("chatHistory", room.messages.slice(-100));
  if (["choosing", "drawing"].includes(room.phase)) {
    socket.emit("drawSnapshot", room.drawOps);
  }
  if (!reclaimed) addSystem(room, `${player.name} bergabung.`);
  broadcastState(room);
  return { ok: true, code: room.code, playerId: player.id, name: player.name };
}

function leaveRoom(socket, reason) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return;
  const playerId = socket.data.playerId;
  socket.data.roomCode = null;
  socket.data.playerId = null;
  socket.leave(room.code);

  const p = room.player(playerId);
  if (!p) return;
  const inGame = ["choosing", "drawing", "turnEnd", "roundEnd"].includes(room.phase);

  if (!inGame) {
    p.connected = false;
    room.removePlayer(playerId);
    addSystem(room, `${p.name} keluar.`);
  } else {
    p.connected = false;
    if (playerId === room.drawerId) {
      room.finishTurn("penggambar keluar");
      addSystem(room, `${p.name} keluar saat menggambar.`);
    } else {
      // Beri kesempatan menyambung kembali sebelum permainan dihentikan.
      room.scheduleConnectivityCheck();
      const detik = Math.round(RECONNECT_GRACE_MS / 1000);
      addSystem(room, `${p.name} terputus — menunggu sambungan kembali (${detik} dtk).`);
    }
  }
  broadcastState(room);

  if (room.connectedPlayers.length === 0 && !inGame) {
    room.destroy();
    rooms.delete(room.code);
  }
}

io.on("connection", (socket) => {
  socket.data = { roomCode: null, playerId: null, rate: {} };

  const cb = (fn, payload) => {
    if (typeof fn === "function") fn(payload);
  };

  socket.on("themes", (fn) => cb(fn, { themes: listThemes() }));

  socket.on("createRoom", (data = {}, fn) => {
    try {
      if (socket.data.roomCode) leaveRoom(socket, "switch");
      const room = createRoom();
      const res = joinAs(socket, room, data.name);
      cb(fn, res);
    } catch (err) {
      console.error("createRoom:", err);
      cb(fn, { error: "Gagal membuat room." });
    }
  });

  socket.on("joinRoom", (data = {}, fn) => {
    try {
      const code = String(data.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return cb(fn, { error: `Room "${code}" tidak ditemukan.` });
      if (socket.data.roomCode === code) return cb(fn, { error: "Sudah berada di room ini." });
      if (room.players.length >= MAX_PLAYERS && !room.reclaim(data.name)) {
        return cb(fn, { error: "Room penuh." });
      }
      if (socket.data.roomCode) leaveRoom(socket, "switch");
      const res = joinAs(socket, room, data.name);
      cb(fn, res);
    } catch (err) {
      console.error("joinRoom:", err);
      cb(fn, { error: "Gagal masuk room." });
    }
  });

  socket.on("setReady", (data = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !socket.data.playerId) return;
    room.setReady(socket.data.playerId, !!data.ready);
    broadcastState(room);
  });

  socket.on("startGame", (data = {}, fn) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb(fn, { error: "Room tidak ditemukan." });
    if (room.hostId !== socket.data.playerId) return cb(fn, { error: "Hanya host yang bisa memulai." });
    const before = room.players.length;
    const res = room.startGame(data.theme);
    if (res.error) return cb(fn, res);
    addSystem(room, `Permainan dimulai — tema ${room.theme}, 3 ronde, ${before} pemain.`);
    cb(fn, res);
  });

  socket.on("pickWord", (data = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    room.chooseWord(socket.data.playerId, data.word);
  });

  socket.on("guess", (data = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !socket.data.playerId) return;
    if (!rateOk(socket, "chat", CHAT_MAX)) return;
    const p = room.player(socket.data.playerId);
    if (!p) return;

    const text = String(data.text || "").slice(0, 80).trim();
    if (!text) return;

    // Di luar fase menggambar, pesan hanyalah obrolan biasa.
    if (room.phase !== "drawing") {
      const msg = { id: `${Date.now()}-${Math.random()}`, from: p.id, name: p.name, text, kind: "normal", ts: Date.now() };
      room.messages.push(msg);
      if (room.messages.length > 100) room.messages.shift();
      io.to(room.code).emit("chat", msg);
      return;
    }

    const result = room.guess(socket.data.playerId, text);
    if (result.ignore) return;

    if (result.drawerChat) {
      const msg = { id: `${Date.now()}-${Math.random()}`, from: p.id, name: p.name, text, kind: "drawer", ts: Date.now() };
      room.messages.push(msg);
      if (room.messages.length > 100) room.messages.shift();
      io.to(room.code).emit("chat", msg);
      return;
    }
    if (result.correct) {
      const msg = {
        id: `${Date.now()}-${Math.random()}`, from: p.id, name: p.name, text: "menebak dengan benar!",
        kind: "correct", points: result.points, ts: Date.now(),
      };
      room.messages.push(msg);
      if (room.messages.length > 100) room.messages.shift();
      io.to(room.code).emit("chat", msg);
      if (result.allDone) addSystem(room, "Semua pemain sudah menebak — giliran selesai.");
      broadcastState(room);
      return;
    }
    if (result.notPlaying) {
      const msg = { id: `${Date.now()}-${Math.random()}`, from: null, name: "Sistem", text: "Tidak ada yang sedang menggambar.", kind: "system", ts: Date.now() };
      socket.emit("chat", msg);
      return;
    }
    if (result.alreadyGuessed) {
      socket.emit("chat", {
        id: `${Date.now()}-${Math.random()}`, from: null, name: "Sistem",
        text: "Kamu sudah menebak dengan benar.", kind: "system", ts: Date.now(),
      });
      return;
    }
    // salah
    const msg = { id: `${Date.now()}-${Math.random()}`, from: p.id, name: p.name, text, kind: "normal", ts: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > 100) room.messages.shift();
    io.to(room.code).emit("chat", msg);
  });

  socket.on("draw", (op) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !socket.data.playerId) return;
    if (room.drawerId !== socket.data.playerId) return;
    if (room.phase !== "drawing") return;
    if (!rateOk(socket, "draw", DRAW_MAX)) return;
    if (!op || typeof op !== "object") return;

    const clean = sanitizeOp(op);
    if (!clean) return;
    room.recordDrawOp(clean);
    socket.to(room.code).emit("draw", clean);
  });

  socket.on("playAgain", (data = {}, fn) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb(fn, { error: "Room tidak ditemukan." });
    if (room.hostId !== socket.data.playerId) return cb(fn, { error: "Hanya host yang bisa memulai ulang." });
    if (room.phase !== "gameEnd") return cb(fn, { error: "Permainan belum selesai." });
    room.backToLobby();
    addSystem(room, "Kembali ke lobby — siapkan diri untuk ronde baru.");
    broadcastState(room);
    cb(fn, { ok: true });
  });

  socket.on("leaveRoom", () => leaveRoom(socket, "manual"));

  socket.on("disconnect", () => {
    try {
      leaveRoom(socket, "disconnect");
    } catch (err) {
      console.error("disconnect:", err);
    }
  });
});

function sanitizeOp(op) {
  const type = op.type;
  if (type === "clear") return { type: "clear" };
  if (type !== "line") return null;
  const color = typeof op.color === "string" && /^#[0-9a-fA-F]{6}$/.test(op.color) ? op.color : "#111111";
  const size = Math.min(60, Math.max(1, Number(op.size) || 4));
  const eraser = !!op.eraser;
  if (!Array.isArray(op.points)) return null;
  const points = op.points.slice(0, 64).map((pt) => [
    Math.min(1, Math.max(0, Number(pt[0]) || 0)),
    Math.min(1, Math.max(0, Number(pt[1]) || 0)),
  ]);
  if (!points.length) return null;
  return { type: "line", points, color, size, eraser };
}

// Bersihkan room yang tidak ada pemainnya.
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.connectedPlayers.length === 0) {
      room.destroy();
      rooms.delete(code);
    }
  }
}, 60000).unref();

server.listen(PORT, () => {
  console.log(`Game tebak gambar berjalan di http://localhost:${PORT}  (port ${PORT})`);
});