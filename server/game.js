/**
 * Logika game: room, lobby, ronde, giliran menggambar, tebakan, skor, timer.
 * Modul ini bebas socket; server.js menyediakan hooks:
 *   { broadcastState(), emit(event, payload) }
 */
const { pickWords, themeLabel } = require("./words");

const TOTAL_ROUNDS = 3;
const TURN_SECONDS = 75;
const CHOOSE_SECONDS = 15;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const TURN_END_DELAY_MS = 3500;
const RECONNECT_GRACE_MS = 20000;
const ROUND_END_DELAY_MS = 5000;
// % sisa waktu: berapa huruf yang dibuka (bertahap)
const HINT_AT = [60, 40, 20];

let nextPlayerId = 1;

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Room {
  constructor(code, hooks = {}) {
    this.code = code;
    this.hooks = hooks;
    // Durasi dapat dipercepat lewat hooks.timings (dipakai test otomatis).
    this.timings = {
      chooseMs: CHOOSE_SECONDS * 1000,
      turnEndMs: TURN_END_DELAY_MS,
      roundEndMs: ROUND_END_DELAY_MS,
      tickMs: 1000,
      ...(hooks.timings || {}),
    };
    this.players = [];
    this.hostId = null;
    this.phase = "lobby"; // lobby | choosing | drawing | turnEnd | roundEnd | gameEnd
    this.round = 0;
    this.turnIndex = 0;
    this.order = [];
    this.drawerId = null;
    this.word = "";
    this.options = [];
    this.revealed = 0;
    this.revealOrder = [];
    this.usedWords = [];
    this.theme = "random";
    this.secondsLeft = 0;
    this.messages = [];
    this.drawOps = [];
    this.lastTurn = null;
    this.tickTimer = null;
    this.phaseTimer = null;
    this.graceTimer = null;
    this.endReason = null;
  }

  // ------------------------------------------------------------- keadaan
  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  playersView() {
    return this.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      ready: p.ready,
      connected: p.connected,
      guessed: p.guessed,
      isDrawer: p.id === this.drawerId,
      isHost: p.id === this.hostId,
    }));
  }

  sortedScoreboard() {
    return this.playersView().slice().sort((a, b) => b.score - a.score);
  }

  letterCount() {
    return this.word ? (this.word.match(/[a-z0-9]/gi) || []).length : 0;
  }

  /** Kata dengan huruf terbuka sesuai progres petunjuk. */
  maskedWord() {
    if (!this.word) return "";
    const showAll = this.phase === "turnEnd" || this.phase === "roundEnd" || this.phase === "gameEnd";
    const limit = showAll ? this.revealOrder.length : this.revealed;
    return this.word
      .split("")
      .map((c, i) => {
        if (!/[a-z0-9]/i.test(c)) return c;
        const letterRank = this.revealOrder.indexOf(i);
        return letterRank >= 0 && letterRank < limit ? c : "_";
      })
      .join(" ");
  }

  stateFor(viewerId) {
    const viewer = this.player(viewerId);
    const isDrawer = viewerId === this.drawerId;
    const inRound = ["choosing", "drawing", "turnEnd", "roundEnd"].includes(this.phase);
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      totalRounds: TOTAL_ROUNDS,
      theme: this.theme,
      themeLabel: themeLabel(this.theme),
      players: this.playersView(),
      scoreboard: this.phase === "roundEnd" || this.phase === "gameEnd" ? this.sortedScoreboard() : null,
      hostId: this.hostId,
      me: viewer ? { id: viewer.id, name: viewer.name } : null,
      drawerId: this.drawerId,
      drawerName: this.drawerId ? (this.player(this.drawerId) || {}).name : null,
      word: isDrawer ? this.word : "",
      maskedWord: inRound ? this.maskedWord() : "",
      options: this.phase === "choosing" && isDrawer ? this.options.slice() : [],
      secondsLeft: Math.max(0, this.secondsLeft),
      turnTotal: this.phase === "choosing" ? CHOOSE_SECONDS : TURN_SECONDS,
      inRound,
      endReason: this.endReason,
      lastTurn: this.lastTurn,
    };
  }

  get connectedPlayers() {
    return this.players.filter((p) => p.connected);
  }

  // ------------------------------------------------------------- anggota
  addPlayer(name) {
    if (this.players.length >= MAX_PLAYERS) return { error: "Room penuh (maks 10 pemain)." };
    const clean = String(name || "").trim().slice(0, 16) || "Pemain";
    const clash = this.players.some((p) => normalize(p.name) === normalize(clean));
    const player = {
      id: `p${nextPlayerId++}`,
      name: clash ? `${clean} ${this.players.length + 1}` : clean,
      score: 0,
      ready: false,
      connected: true,
      guessed: false,
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = player.id;
    return { player };
  }

  /** Reconnect: pemain lama dengan nama sama yang terputus boleh masuk kembali. */
  reclaim(name) {
    const found = this.players.find(
      (p) => !p.connected && normalize(p.name) === normalize(String(name).trim())
    );
    if (found) found.connected = true;
    return found;
  }

  /**
   * @returns "empty" | "turn-end" | "game-end" | true
   */
  removePlayer(playerId) {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return false;
    const wasDrawer = playerId === this.drawerId;
    this.players.splice(idx, 1);
    if (this.hostId === playerId) this.hostId = this.players.length ? this.players[0].id : null;
    if (this.players.length === 0) return "empty";
    if (["choosing", "drawing", "turnEnd", "roundEnd"].includes(this.phase)) {
      if (wasDrawer) return "turn-end";
      if (this.connectedPlayers.length < MIN_PLAYERS) return "game-end";
    }
    return true;
  }

  setReady(playerId, ready) {
    const p = this.player(playerId);
    if (p && this.phase === "lobby") p.ready = !!ready;
  }

  canStart() {
    if (this.phase !== "lobby") return "Permainan sudah berjalan.";
    if (this.players.length < MIN_PLAYERS) return `Butuh minimal ${MIN_PLAYERS} pemain.`;
    return null;
  }

  // ------------------------------------------------------------- alur game
  startGame(theme) {
    const err = this.canStart();
    if (err) return { error: err };
    this.theme = theme || "random";
    this.round = 1;
    this.turnIndex = 0;
    this.usedWords = [];
    this.lastTurn = null;
    this.endReason = null;
    this.players.forEach((p) => {
      p.score = 0;
      p.ready = false;
      p.guessed = false;
    });
    this.order = shuffle(this.connectedPlayers.map((p) => p.id));
    this.beginTurn();
    return { ok: true };
  }

  beginTurn() {
    this.clearTimers();
    if (this.connectedPlayers.length < MIN_PLAYERS) {
      this.endGame("pemain kurang");
      this.hooks.emit("gameEnd", this.endPayload());
      this.hooks.broadcastState();
      return "end";
    }

    if (this.turnIndex >= this.order.length) return this.beginRoundEnd();

    const drawerId = this.order[this.turnIndex++];
    const drawer = this.player(drawerId);
    // Lewati pemain yang keluar/terputus sebelum gilirannya.
    if (!drawer || !drawer.connected) return this.beginTurn();

    this.drawerId = drawerId;
    this.options = pickWords(this.theme, 3, this.usedWords);
    this.word = "";
    this.revealed = 0;
    this.revealOrder = [];
    this.drawOps = [];
    this.lastTurn = null;
    this.players.forEach((p) => (p.guessed = false));
    this.phase = "choosing";
    this.secondsLeft = CHOOSE_SECONDS;
    this.startTicker();

    this.phaseTimer = setTimeout(() => {
      if (this.phase === "choosing" && this.drawerId === drawerId) {
        this.chooseWord(drawerId, this.options[0]);
      }
    }, this.timings.chooseMs);
    this.hooks.broadcastState();
    return "ok";
  }

  chooseWord(playerId, word) {
    if (this.phase !== "choosing" || playerId !== this.drawerId) {
      return { error: "Bukan giliran memilih kata." };
    }
    const chosen = this.options.includes(word) ? word : this.options[0];
    this.word = chosen;
    this.usedWords.push(chosen);
    this.revealOrder = this.buildRevealOrder(chosen);
    this.revealed = 0;
    this.phase = "drawing";
    this.secondsLeft = TURN_SECONDS;
    this.clearPhaseTimer();
    this.startTicker();
    this.hooks.emit("wordChosen", { word: chosen });
    this.hooks.broadcastState();
    return { ok: true, word: chosen };
  }

  buildRevealOrder(word) {
    const letters = [];
    word.split("").forEach((c, i) => {
      if (/[a-z0-9]/i.test(c)) letters.push(i);
    });
    // Konsonan dibuka lebih dulu agar petunjuk lebih membantu.
    return shuffle(letters).sort((a, b) => {
      const va = "aiueo".includes(word[a].toLowerCase()) ? 1 : 0;
      const vb = "aiueo".includes(word[b].toLowerCase()) ? 1 : 0;
      return va - vb;
    });
  }

  startTicker() {
    this.clearTicker();
    this.tickTimer = setInterval(() => {
      this.secondsLeft -= 1;
      const total = this.phase === "choosing" ? CHOOSE_SECONDS : TURN_SECONDS;
      const pct = (this.secondsLeft / total) * 100;
      const passed = HINT_AT.filter((t) => pct <= t).length;
      this.revealed = Math.min(passed, this.letterCount());

      if (this.secondsLeft <= 0) {
        if (this.phase === "choosing") this.chooseWord(this.drawerId, this.options[0]);
        else this.finishTurn("waktu habis");
      }
      this.hooks.broadcastState();
    }, this.timings.tickMs);
  }

  /**
   * @returns { ignore } | { drawerChat } | { wrong } | { correct, points, allDone }
   */
  guess(playerId, text) {
    const player = this.player(playerId);
    if (!player) return { ignore: true };
    const guessText = String(text || "").slice(0, 80).trim();
    if (!guessText) return { ignore: true };
    if (this.phase !== "drawing") return { wrong: true, text: guessText, notPlaying: true };
    if (playerId === this.drawerId) return { drawerChat: true, text: guessText };
    if (player.guessed) return { alreadyGuessed: true, text: guessText };
    if (normalize(guessText) !== normalize(this.word)) return { wrong: true, text: guessText };

    const points = 100 + Math.min(150, Math.round(this.secondsLeft * 2));
    player.score += points;
    player.guessed = true;
    const guessers = this.players.filter((p) => p.id !== this.drawerId);
    const allDone = guessers.filter((p) => p.connected).every((p) => p.guessed);
    if (allDone) {
      const drawer = this.player(this.drawerId);
      if (drawer) drawer.score += 50;
      this.finishTurn("semua menebak");
    }
    return { correct: true, points, allDone };
  }

  recordDrawOp(op) {
    if (op.type === "clear") this.drawOps = [];
    else this.drawOps.push(op);
    if (this.drawOps.length > 4000) this.drawOps.shift();
  }

  finishTurn(reason) {
    if (!["choosing", "drawing"].includes(this.phase)) return false;
    this.clearTimers();
    const word = this.word || this.options[0] || "";
    this.word = word;
    this.revealOrder = this.buildRevealOrder(word);
    this.revealed = this.revealOrder.length;

    const drawer = this.player(this.drawerId);
    if (drawer) {
      const guessers = this.players.filter((p) => p.id !== this.drawerId);
      const anyGuessed = guessers.some((p) => p.guessed);
      if (reason !== "semua menebak") drawer.score += anyGuessed ? 25 : 10;
    }
    this.phase = "turnEnd";
    this.secondsLeft = 0;
    this.lastTurn = { word, reason, drawerId: this.drawerId, drawerName: drawer ? drawer.name : "" };
    this.hooks.emit("turnEnd", this.lastTurn);
    this.hooks.broadcastState();

    this.phaseTimer = setTimeout(() => this.advance(), this.timings.turnEndMs);
    return true;
  }

  advance() {
    this.clearPhaseTimer();
    if (["lobby", "gameEnd"].includes(this.phase)) return;
    if (this.connectedPlayers.length < MIN_PLAYERS) {
      this.endGame("pemain kurang");
      this.hooks.emit("gameEnd", this.endPayload());
      this.hooks.broadcastState();
      return;
    }
    if (this.turnIndex >= this.order.length) this.beginRoundEnd();
    else this.beginTurn();
  }

  beginRoundEnd() {
    this.clearTimers();
    this.phase = "roundEnd";
    this.secondsLeft = 0;
    this.drawerId = null;
    this.word = "";
    this.hooks.emit("roundEnd", { round: this.round, scoreboard: this.sortedScoreboard() });
    this.hooks.broadcastState();

    this.phaseTimer = setTimeout(() => {
      this.clearPhaseTimer();
      if (this.phase !== "roundEnd") return;
      if (this.round >= TOTAL_ROUNDS) {
        this.endGame("selesai");
        this.hooks.emit("gameEnd", this.endPayload());
        this.hooks.broadcastState();
        return;
      }
      this.round += 1;
      this.turnIndex = 0;
      this.order = shuffle(this.connectedPlayers.map((p) => p.id));
      this.beginTurn();
    }, this.timings.roundEndMs);
    return "round-end";
  }

  endPayload() {
    return { scoreboard: this.sortedScoreboard(), reason: this.endReason };
  }

  endGame(reason) {
    this.clearTimers();
    this.phase = "gameEnd";
    this.endReason = reason;
    this.drawerId = null;
    this.word = "";
    this.secondsLeft = 0;
  }

  backToLobby() {
    this.clearTimers();
    this.clearGrace();
    this.phase = "lobby";
    this.round = 0;
    this.turnIndex = 0;
    this.drawerId = null;
    this.word = "";
    this.options = [];
    this.drawOps = [];
    this.lastTurn = null;
    this.endReason = null;
    this.secondsLeft = 0;
    this.players.forEach((p) => {
      p.ready = false;
      p.guessed = false;
      p.score = 0;
    });
  }

  clearTicker() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  clearPhaseTimer() {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
  }

  clearTimers() {
    this.clearTicker();
    this.clearPhaseTimer();
  }

  clearGrace() {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  /**
   * Beri waktu pemain yang terputus untuk menyambung kembali sebelum
   * permainan dihentikan karena jumlah pemain kurang.
   */
  scheduleConnectivityCheck(ms = RECONNECT_GRACE_MS) {
    this.clearGrace();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (!["choosing", "drawing", "turnEnd", "roundEnd"].includes(this.phase)) return;
      if (this.connectedPlayers.length >= MIN_PLAYERS) {
        this.hooks.broadcastState();
        return;
      }
      this.endGame("pemain kurang");
      this.hooks.emit("gameEnd", this.endPayload());
      this.hooks.broadcastState();
    }, ms);
    if (this.graceTimer.unref) this.graceTimer.unref();
  }

  destroy() {
    this.clearTimers();
    this.clearGrace();
  }
}

module.exports = {
  Room,
  normalize,
  shuffle,
  TOTAL_ROUNDS,
  TURN_SECONDS,
  CHOOSE_SECONDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  RECONNECT_GRACE_MS,
};