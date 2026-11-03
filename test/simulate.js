/**
 * Uji logika permainan tanpa socket: 3 ronde penuh, 3 pemain.
 * Timer dipercepat supaya test selesai dalam hitungan detik.
 * Jalankan: npm test
 */
const assert = require("assert");
const { Room } = require("../server/game");
const { CATEGORIES, ALL_CATEGORIES, listThemes, pickWords, themeLabel } = require("../server/words");

const timings = { chooseMs: 10, turnEndMs: 10, roundEndMs: 10 };
const events = [];

function makeRoom(code, timingsOverride = timings) {
  return new Room(code, {
    timings: timingsOverride,
    broadcastState() {},
    emit(event, payload) {
      events.push({ event, payload });
    },
  });
}

async function waitFor(predicate, label, timeout = 4000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`Timeout menunggu: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function noWhitespace(text) {
  return String(text).replace(/\s+/g, "");
}

async function fullGame() {
  const room = makeRoom("TEST");
  for (const name of ["Ana", "Budi", "Citra"]) {
    const added = room.addPlayer(name);
    assert.ok(added.player, "pemain ditambahkan");
  }
  assert.strictEqual(room.players.length, 3);
  assert.strictEqual(room.hostId, room.players[0].id, "host = pemain pertama");

  const started = room.startGame("hewan");
  assert.ok(started.ok, "game bisa dimulai");
  assert.strictEqual(room.round, 1);
  assert.strictEqual(room.theme, "hewan");

  const drawerPerRound = new Map();
  let turns = 0;
  let guard = 0;

  while (room.phase !== "gameEnd") {
    if (++guard > 60) throw new Error("Loop permainan tidak berhenti (kemungkinan bug transisi)");

    await waitFor(() => room.phase === "choosing" || room.phase === "gameEnd", "fase memilih kata");
    if (room.phase === "gameEnd") break;

    // -------- fase memilih kata
    assert.strictEqual(room.options.length, 3, "3 pilihan kata");
    assert.strictEqual(new Set(room.options).size, 3, "pilihan kata unik");
    const drawer = room.player(room.drawerId);
    assert.ok(drawer && drawer.connected, "penggambar ada dan terhubung");
    assert.ok(CATEGORIES.hewan.words.includes(room.options[0]), "kata sesuai tema");

    const guesserId = room.players.find((p) => p.id !== room.drawerId).id;
    assert.strictEqual(room.stateFor(guesserId).options.length, 0, "penebak tidak melihat pilihan kata");
    assert.strictEqual(room.stateFor(room.drawerId).options.length, 3, "penggambar melihat pilihan kata");

    const word = room.options[2];
    const pick = room.chooseWord(room.drawerId, word);
    assert.ok(pick.ok, "kata berhasil dipilih");
    assert.strictEqual(room.phase, "drawing");
    assert.strictEqual(room.word, word);
    assert.strictEqual(room.stateFor(room.drawerId).word, word, "penggambar melihat kata");
    assert.strictEqual(room.stateFor(guesserId).word, "", "penebak tidak melihat kata");
    assert.ok(room.stateFor(guesserId).maskedWord.includes("_"), "kata penebak disamarkan");

    // -------- interaksi selama menggambar
    assert.ok(room.guess(guesserId, "jawaban salah").wrong, "tebakan salah ditolak");
    assert.ok(room.guess(room.drawerId, "halo").drawerChat, "penggambar hanya bisa chat");

    // -------- semua penebak menebak benar
    for (const p of room.players.filter((x) => x.id !== room.drawerId)) {
      if (room.phase !== "drawing") break;
      const result = room.guess(p.id, room.word.toUpperCase());
      assert.ok(result.correct, `tebakan benar diterima (${p.name})`);
      assert.ok(result.points >= 100, "poin tebakan minimal 100");
      if (room.phase === "drawing") {
        const again = room.guess(p.id, room.word);
        assert.ok(again.alreadyGuessed, "tebakan ganda ditolak");
      }
    }
    assert.strictEqual(room.phase, "turnEnd", "giliran berakhir setelah semua menebak");
    assert.strictEqual(room.lastTurn.word, word);
    assert.strictEqual(
      noWhitespace(room.stateFor(guesserId).maskedWord),
      noWhitespace(word),
      "jawaban terbuka saat giliran berakhir"
    );

    const key = room.round;
    drawerPerRound.set(key, (drawerPerRound.get(key) || new Set()).add(room.drawerId));

    turns++;
    await waitFor(
      () => room.phase === "roundEnd" || room.phase === "choosing" || room.phase === "gameEnd",
      "lanjut ke giliran berikutnya"
    );

    if (room.phase === "roundEnd") {
      const scoreBefore = room.players.map((p) => p.score);
      assert.strictEqual(room.stateFor(room.players[0].id).scoreboard.length, 3, "scoreboard ronde tersedia");
      assert.ok(scoreBefore.some((s) => s > 0), "ada poin di ronde ini");
      await waitFor(() => room.phase === "choosing" || room.phase === "gameEnd", "ronde berikutnya");
    }
  }

  // -------- hasil akhir
  assert.strictEqual(room.phase, "gameEnd");
  assert.strictEqual(room.round, 3, "tepat 3 ronde");
  assert.strictEqual(room.endReason, "selesai");
  assert.strictEqual(turns, 9, "9 giliran (3 pemain x 3 ronde)");

  for (let round = 1; round <= 3; round++) {
    assert.strictEqual(drawerPerRound.get(round).size, 3, `ronde ${round}: semua pemain menggambar sekali`);
  }

  const board = room.sortedScoreboard();
  assert.strictEqual(board.length, 3);
  for (let i = 1; i < board.length; i++) {
    assert.ok(board[i - 1].score >= board[i].score, "scoreboard terurut menurun");
  }
  assert.ok(board.every((p) => p.score > 0), "semua pemain mendapat poin");

  const endEvent = events.filter((e) => e.event === "gameEnd").pop();
  assert.ok(endEvent, "event gameEnd dikirim");
  assert.strictEqual(endEvent.payload.scoreboard.length, 3);

  // -------- main lagi
  room.backToLobby();
  assert.strictEqual(room.phase, "lobby");
  assert.ok(room.players.every((p) => p.score === 0), "skor direset");
  room.destroy();
  return room;
}

function lobbyRules() {
  const room = makeRoom("LOBBY");
  room.addPlayer("Solo");
  assert.ok(room.startGame("random").error, "1 pemain tidak bisa memulai");

  room.addPlayer("Duo");
  room.addPlayer("Trio");
  const hostId = room.hostId;
  assert.strictEqual(room.removePlayer(hostId), true);
  assert.strictEqual(room.hostId, room.players[0].id, "host berpindah saat host keluar");
  assert.ok(room.startGame("random").ok, "2 pemain bisa memulai");

  // pemain terputus lalu kembali
  const p = room.players.find((x) => x.id !== room.drawerId);
  p.connected = false;
  assert.strictEqual(room.connectedPlayers.length, 1);
  const back = room.reclaim(p.name.toUpperCase());
  assert.strictEqual(back.id, p.id, "reconnect memakai pemain lama");
  assert.ok(p.connected);
  assert.strictEqual(room.reclaim("Nama Asing"), undefined, "nama asing tidak bisa reclaim");

  room.destroy();
}

function disconnectedDrawerSkipped() {
  const room = makeRoom("SKIP");
  room.addPlayer("A");
  room.addPlayer("B");
  room.addPlayer("C");
  room.startGame("random");
  const drawerId = room.drawerId;
  room.word = room.options[0];
  const idx = room.order.indexOf(drawerId);
  room.order.splice(idx, 1); // paksa penggambar keluar dari urutan
  room.players.find((p) => p.id === drawerId).connected = false;
  room.chooseWord(drawerId, room.options[0]);
  room.finishTurn("penggambar keluar");
  assert.strictEqual(room.phase, "turnEnd");
  room.destroy();
}

function datasetRules() {
  assert.ok(ALL_CATEGORIES.length >= 11, "minimal 11 tema kata");
  const seen = new Map();
  for (const key of ALL_CATEGORIES) {
    const words = CATEGORIES[key].words;
    assert.ok(words.length >= 20, `tema ${key} punya minimal 20 kata`);
    for (const word of words) {
      assert.strictEqual(word, String(word).trim(), `kata "${word}" tanpa spasi berlebih`);
      assert.ok(word.length >= 3, `kata "${word}" cukup panjang`);
      const lower = word.toLowerCase();
      assert.ok(!seen.has(lower), `kata "${word}" duplikat (${key} vs ${seen.get(lower)})`);
      seen.set(lower, key);
    }
    const picked = pickWords(key, 3);
    assert.strictEqual(picked.length, 3, `tema ${key} memberi 3 kata`);
    assert.strictEqual(new Set(picked).size, 3, `tema ${key} memberi kata unik`);
    picked.forEach((w) => assert.ok(words.includes(w), `kata "${w}" berasal dari tema ${key}`));
    assert.strictEqual(themeLabel(key), CATEGORIES[key].label);
  }
  const pool = pickWords("hewan", 20, ["kucing"]);
  assert.ok(!pool.includes("kucing"), "kata yang sudah dipakai tidak terpilih lagi");
  const random = pickWords("random", 3);
  assert.strictEqual(new Set(random).size, 3, "3 kata acak unik");
  assert.strictEqual(listThemes().length, ALL_CATEGORIES.length);
  console.log(`  · dataset: ${ALL_CATEGORIES.length} tema, ${seen.size} kata unik`);
}

(async () => {
  try {
    datasetRules();
    await fullGame();
    lobbyRules();
    disconnectedDrawerSkipped();
    console.log("✔ Simulasi logika lulus: 3 ronde, 3 pemain, skor & transisi fase benar.");
    process.exit(0);
  } catch (error) {
    console.error("✘ Simulasi gagal:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
