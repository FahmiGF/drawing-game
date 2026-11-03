/**
 * Uji end-to-end: server sungguhan + beberapa klien Socket.IO.
 * Menguji lobby, 3 ronde penuh, relay gambar, keamanan peran, chat, dan reconnect.
 * Jalankan: npm run test:e2e
 */
const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");
const { io } = require("socket.io-client");
const { CATEGORIES } = require("../server/words");

const PORT = 4399;
const URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server = null;
let serverLog = "";
const sockets = [];

function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server", "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CHOOSE_MS: "3000",
      TURN_END_MS: "300",
      ROUND_END_MS: "400",
      TICK_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    serverLog += String(chunk);
  });
  server.stderr.on("data", (chunk) => {
    serverLog += String(chunk);
  });
}

function connect() {
  const socket = io(URL, { transports: ["websocket"], reconnection: false, forceNew: true, timeout: 5000 });
  socket.latest = null;
  socket.chats = [];
  socket.snapshots = null;
  socket.on("roomState", (state) => {
    socket.latest = state;
  });
  socket.on("chat", (msg) => socket.chats.push(msg));
  socket.on("drawSnapshot", (ops) => {
    socket.snapshots = ops;
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

const ack = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

async function waitFor(socket, predicate, label, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (socket.latest && predicate(socket.latest)) return socket.latest;
    await sleep(15);
  }
  const st = socket.latest || {};
  throw new Error(
    `Timeout: ${label} (phase=${st.phase}, round=${st.round}, pemain=${(st.players || []).length})`
  );
}

async function connectWithRetry(attempts = 60) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await connect();
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(`Server tidak siap: ${lastError && lastError.message}\n${serverLog}`);
}

function myPlayer(state) {
  const me = state.players.find((p) => p.id === state.me.id);
  assert.ok(me, "data pemain sendiri ada");
  return me;
}

async function playTurn(host, clients, round, turn) {
  await waitFor(host, (s) => s.phase === "choosing" && s.round === round, `ronde ${round} memilih kata`);
  for (const client of clients) {
    await waitFor(client, (s) => s.phase === "choosing" && s.round === round, `klien melihat fase memilih (ronde ${round})`);
  }
  const choosing = host.latest;
  const drawer = clients.find((cl) => cl.latest.me.id === choosing.drawerId);
  assert.ok(drawer, "penggambar teridentifikasi di klien");
  assert.strictEqual(drawer.latest.options.length, 3, "penggambar melihat 3 pilihan kata");
  assert.strictEqual(drawer.latest.word, "", "kata belum dipilih");

  const others = clients.filter((cl) => cl !== drawer);
  for (const other of others) {
    assert.strictEqual(other.latest.options.length, 0, "penebak tidak melihat pilihan kata");
    assert.strictEqual(other.latest.drawerName, drawer.latest.me.name);
  }

  // Pemain lain tidak boleh memilih kata.
  others[0].emit("pickWord", { word: "curang" });
  await sleep(80);
  assert.strictEqual(host.latest.phase, "choosing", "hanya penggambar yang bisa memilih kata");

  const word = drawer.latest.options[turn % 3];
  assert.ok(CATEGORIES.hewan.words.includes(word), "kata berasal dari tema yang dipilih");
  drawer.emit("pickWord", { word });

  await waitFor(host, (s) => s.phase === "drawing", "fase menggambar");
  for (const client of others) {
    await waitFor(client, (s) => s.phase === "drawing", "penebak melihat fase menggambar");
  }
  assert.strictEqual(drawer.latest.word, word, "penggambar melihat kata asli");
  for (const other of others) {
    assert.strictEqual(other.latest.word, "", "kata asli tidak bocor ke penebak");
    assert.ok(other.latest.maskedWord.includes("_"), "kata penebak disamarkan");
  }

  // Relay goresan gambar ke pemain lain.
  const received = [];
  const onDraw = (op) => received.push(op);
  others[0].on("draw", onDraw);
  drawer.emit("draw", { type: "line", points: [[0.1, 0.1], [0.55, 0.45]], color: "#ff0000", size: 12 });
  await sleep(150);
  others[0].off("draw", onDraw);
  assert.strictEqual(received.length, 1, "goresan penggambar diteruskan");
  assert.strictEqual(received[0].points.length, 2);
  assert.strictEqual(received[0].color, "#ff0000");

  // Penebak tidak boleh menggambar di kanvas orang lain.
  const leaked = [];
  const onDrawDrawer = (op) => leaked.push(op);
  drawer.on("draw", onDrawDrawer);
  others[0].emit("draw", { type: "line", points: [[0.2, 0.2]], color: "#000000", size: 8 });
  await sleep(150);
  drawer.off("draw", onDrawDrawer);
  assert.strictEqual(leaked.length, 0, "hanya penggambar yang bisa menggambar");

  // Tebakan salah & tebakan benar.
  others[0].emit("guess", { text: "ini salah" });
  await sleep(120);
  assert.ok(
    host.chats.some((m) => m.text === "ini salah" && m.kind === "normal"),
    "tebakan salah muncul sebagai chat"
  );
  assert.strictEqual(host.latest.phase, "drawing", "tebakan salah tidak mengakhiri giliran");

  for (const other of others) {
    other.emit("guess", { text: word.toUpperCase() });
  }
  const turnEnd = await waitFor(host, (s) => s.phase === "turnEnd", "giliran selesai setelah semua menebak");
  assert.strictEqual(turnEnd.lastTurn.word, word);
  assert.strictEqual(turnEnd.lastTurn.reason, "semua menebak");
  for (const other of others) {
    await waitFor(other, (s) => s.phase === "turnEnd", "penebak melihat akhir giliran");
    assert.ok(myPlayer(other.latest).guessed, "status menebak tercatat");
    assert.ok(myPlayer(other.latest).score > 0, "penebak mendapat poin");
    assert.strictEqual(
      other.latest.maskedWord.replace(/\s+/g, ""),
      word.replace(/\s+/g, ""),
      "jawaban dibuka di akhir giliran"
    );
  }
  assert.ok(
    host.chats.some((m) => m.kind === "correct" && m.points > 0),
    "chat jawaban benar berisi poin"
  );
  return word;
}

async function mainGame() {
  const host = await connectWithRetry();

  const bad = await ack(host, "joinRoom", { code: "ZZZZ", name: "Hantu" });
  assert.ok(bad.error, "room tak dikenal ditolak");
  assert.ok((await ack(host, "joinRoom", { code: "AB", name: "Hantu" })).error, "kode pendek ditolak");

  const created = await ack(host, "createRoom", { name: "Ana" });
  assert.ok(created.ok, "room dibuat");
  assert.strictEqual(String(created.code).length, 4);
  const roomCode = created.code;

  const b = await connect();
  const c = await connect();
  assert.ok((await ack(b, "joinRoom", { code: roomCode, name: "Budi" })).ok, "Budi bergabung");
  assert.ok((await ack(c, "joinRoom", { code: roomCode.toLowerCase(), name: "Citra" })).ok, "kode huruf kecil diterima");

  const lobby = await waitFor(host, (s) => s.players.length === 3, "3 pemain di lobby");
  assert.strictEqual(lobby.phase, "lobby");
  assert.strictEqual(lobby.hostId, created.playerId, "pembuat room menjadi host");
  assert.strictEqual(lobby.themeLabel, "Campuran", "label tema default");

  const chatPromise = sleep(150);
  b.emit("guess", { text: "halo semua" });
  await chatPromise;
  assert.ok(host.chats.some((m) => m.text === "halo semua" && m.kind === "normal"), "chat lobby berfungsi");

  b.emit("setReady", { ready: true });
  await waitFor(host, (s) => s.players.find((p) => p.id === b.latest.me.id).ready === true, "status siap");

  assert.ok((await ack(b, "startGame", { theme: "hewan" })).error, "non-host tidak bisa memulai");
  const started = await ack(host, "startGame", { theme: "hewan" });
  assert.ok(started.ok, "host memulai permainan");

  const clients = [host, b, c];
  let turns = 0;
  for (let round = 1; round <= 3; round++) {
    for (let turn = 0; turn < 3; turn++) {
      await playTurn(host, clients, round, turn);
      turns++;
    }
    if (round < 3) {
      await waitFor(host, (s) => s.round === round + 1 && s.phase === "choosing", `ronde ${round + 1} dimulai`);
    }
  }

  const ended = await waitFor(host, (s) => s.phase === "gameEnd", "permainan selesai", 12000);
  assert.strictEqual(ended.round, 3, "berhenti tepat di ronde 3");
  assert.strictEqual(turns, 9, "9 giliran untuk 3 pemain x 3 ronde");
  assert.strictEqual(ended.endReason, "selesai");
  const board = ended.scoreboard;
  assert.strictEqual(board.length, 3);
  assert.ok(board.every((p) => p.score > 0), "semua pemain punya poin");
  for (let i = 1; i < board.length; i++) {
    assert.ok(board[i - 1].score >= board[i].score, "scoreboard terurut");
  }
  for (const client of clients) {
    await waitFor(client, (s) => s.phase === "gameEnd", "semua klien melihat gameEnd");
  }

  assert.ok((await ack(b, "playAgain")).error, "hanya host bisa main lagi");
  assert.ok((await ack(host, "playAgain")).ok, "host mengulang permainan");
  const back = await waitFor(host, (s) => s.phase === "lobby", "kembali ke lobby");
  assert.ok(back.players.every((p) => p.score === 0), "skor direset saat kembali ke lobby");

  host.close();
  b.close();
  c.close();
}

async function reconnectTest() {
  const e = await connect();
  const f = await connect();
  const created = await ack(e, "createRoom", { name: "Eko" });
  assert.ok(created.ok);
  await ack(f, "joinRoom", { code: created.code, name: "Fani" });
  await waitFor(e, (s) => s.players.length === 2, "2 pemain (reconnect test)");

  assert.ok((await ack(e, "startGame", { theme: "random" })).ok);
  await waitFor(e, (s) => s.phase === "choosing", "memilih kata (reconnect test)");

  const drawer = e.latest.drawerId === e.latest.me.id ? e : f;
  const guesser = drawer === e ? f : e;
  const word = drawer.latest.options[0];
  drawer.emit("pickWord", { word });
  await waitFor(guesser, (s) => s.phase === "drawing", "fase menggambar (reconnect test)");
  assert.strictEqual(guesser.latest.word, "");

  drawer.emit("draw", { type: "line", points: [[0.2, 0.2], [0.8, 0.6]], color: "#123456", size: 10 });
  await sleep(150);

  const guesserId = guesser.latest.me.id;
  const guesserName = guesser.latest.me.name;
  guesser.close();
  await waitFor(drawer, (s) => s.players.find((p) => p.id === guesserId && !p.connected), "pemain ditandai offline");
  assert.strictEqual(drawer.latest.phase, "drawing", "permainan lanjut setelah penebak terputus");

  const back = await connect();
  const rejoin = await ack(back, "joinRoom", { code: created.code, name: guesserName });
  assert.ok(rejoin.ok, "reconnect berhasil");
  assert.strictEqual(rejoin.playerId, guesserId, "id pemain lama dipulihkan");
  await waitFor(back, (s) => s.phase === "drawing", "state setelah reconnect");
  assert.strictEqual(back.latest.word, "", "kata tetap rahasia setelah reconnect");
  assert.ok(Array.isArray(back.snapshots), "snapshot gambar dikirim ke pemain yang kembali");
  assert.strictEqual(back.snapshots.length, 1, "goresan sebelumnya dipulihkan");

  back.emit("guess", { text: word });
  await waitFor(back, (s) => myPlayer(s).guessed === true, "tebakan setelah reconnect");
  await waitFor(drawer, (s) => s.phase === "turnEnd", "giliran selesai setelah semua menebak");
  assert.ok(drawer.latest.players.find((p) => p.id === guesserId).score > 0);

  back.close();
  drawer.close();
}

(async () => {
  try {
    startServer();
    await mainGame();
    await reconnectTest();
    console.log("✔ E2E lulus: lobby, 3 ronde, relay gambar, aturan peran, chat, skor, dan reconnect.");
    cleanup(0);
  } catch (error) {
    console.error("✘ E2E gagal:", error.message);
    console.error(error.stack);
    if (serverLog.trim()) console.error("--- log server ---\n" + serverLog.trim());
    cleanup(1);
  }
})();

function cleanup(code) {
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      /* abaikan */
    }
  }
  if (server) {
    try {
      server.kill();
    } catch {
      /* abaikan */
    }
  }
  setTimeout(() => process.exit(code), 120);
}
