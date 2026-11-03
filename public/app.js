/* global io */
(() => {
  "use strict";

  const socket = io();
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = "tebak-gambar/session";
  const MAX_CHAT = 100;

  const canvas = $("board");
  const ctx = canvas.getContext("2d");
  const CW = canvas.width;
  const CH = canvas.height;

  let room = null;
  let myId = null;
  let messages = [];
  let canvasKey = null;
  let pendingSnapshot = null;
  let lastOverlay = null;
  let currentScreen = "join";
  let disconnectHappened = false;

  const tool = { color: "#111827", size: 8, eraser: false };
  let stroke = null;
  let flushQueued = false;

  let session = readSession();
  if (session.name) $("nameInput").value = session.name;

  // ------------------------------------------------------------- bantuan
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function clamp01(n) {
    return Math.min(1, Math.max(0, Number(n) || 0));
  }

  function colorFor(name) {
    let hash = 0;
    const text = String(name || "?");
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360;
    return `hsl(${hash}, 65%, 62%)`;
  }

  function readSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  function saveSession(data) {
    session = { name: data.name, code: data.code };
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      /* localStorage bisa diblokir; abaikan */
    }
  }

  function clearSession() {
    session = {};
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* abaikan */
    }
  }

  function showScreen(name) {
    if (currentScreen === name) return;
    currentScreen = name;
    for (const key of ["join", "lobby", "game"]) {
      $("screen-" + key).classList.toggle("hidden", key !== name);
    }
  }

  function showJoinError(text) {
    $("joinError").textContent = text || "";
  }

  // ------------------------------------------------------------- kanvas
  function clearCanvas() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CW, CH);
    ctx.restore();
  }

  function applyOp(op) {
    if (!op) return;
    if (op.type === "clear") {
      clearCanvas();
      return;
    }
    if (op.type !== "line") return;
    const points = Array.isArray(op.points) ? op.points : [];
    if (!points.length) return;
    const color = op.eraser ? "#ffffff" : op.color || "#111827";
    const width = Number(op.size) || 6;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(clamp01(points[0][0]) * CW, clamp01(points[0][1]) * CH, Math.max(1, width / 2), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(clamp01(points[0][0]) * CW, clamp01(points[0][1]) * CH);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(clamp01(points[i][0]) * CW, clamp01(points[i][1]) * CH);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function canDraw() {
    return !!room && room.phase === "drawing" && room.drawerId === myId;
  }

  function pointerPos(event) {
    const rect = canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
  }

  function addPoint(event) {
    if (!stroke) return;
    const [x, y] = pointerPos(event);
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const pt = [clamp01(x), clamp01(y)];
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (stroke.last) {
      ctx.beginPath();
      ctx.moveTo(stroke.last[0] * CW, stroke.last[1] * CH);
      ctx.lineTo(pt[0] * CW, pt[1] * CH);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(pt[0] * CW, pt[1] * CH, Math.max(1, stroke.size / 2), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    stroke.last = pt;
    stroke.buffer.push(pt);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushQueued || !stroke) return;
    flushQueued = true;
    requestAnimationFrame(() => {
      flushQueued = false;
      flushStroke();
    });
  }

  function flushStroke() {
    if (!stroke || !stroke.buffer.length) return;
    let points = stroke.buffer;
    if (stroke.lastSent) points = [stroke.lastSent, ...points];
    else if (points.length === 1) points = [points[0], points[0]];
    socket.emit("draw", {
      type: "line",
      points,
      color: stroke.color,
      size: stroke.size,
      eraser: stroke.eraser,
    });
    stroke.lastSent = points[points.length - 1];
    stroke.buffer = [];
  }

  function endStroke() {
    if (!stroke) return;
    flushStroke();
    stroke = null;
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!canDraw()) return;
    event.preventDefault();
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture opsional */
    }
    stroke = {
      color: tool.eraser ? "#ffffff" : tool.color,
      size: tool.size,
      eraser: tool.eraser,
      last: null,
      buffer: [],
      lastSent: null,
    };
    addPoint(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!stroke) return;
    event.preventDefault();
    addPoint(event);
  });
  for (const evt of ["pointerup", "pointercancel", "pointerleave"]) {
    canvas.addEventListener(evt, endStroke);
  }

  // -------------------------------------------------------------- toolbar
  function updateToolUi() {
    document.querySelectorAll(".swatch").forEach((btn) => {
      btn.classList.toggle("active", !tool.eraser && btn.dataset.color === tool.color);
    });
    document.querySelectorAll(".size").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.size) === tool.size);
    });
    $("eraserBtn").classList.toggle("active", tool.eraser);
  }

  document.querySelectorAll(".swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      tool.color = btn.dataset.color;
      tool.eraser = false;
      updateToolUi();
    });
  });
  document.querySelectorAll(".size").forEach((btn) => {
    btn.addEventListener("click", () => {
      tool.size = Number(btn.dataset.size);
      updateToolUi();
    });
  });
  $("eraserBtn").addEventListener("click", () => {
    tool.eraser = !tool.eraser;
    updateToolUi();
  });
  $("clearBtn").addEventListener("click", () => {
    if (!canDraw()) return;
    clearCanvas();
    socket.emit("draw", { type: "clear" });
  });

  // ----------------------------------------------------------------- chat
  function messageHtml(msg) {
    if (!msg) return "";
    if (msg.kind === "system") return `<div class="msg system">${esc(msg.text)}</div>`;
    const mine = msg.from && msg.from === myId ? " mine" : "";
    if (msg.kind === "correct") {
      const points = msg.points ? ` <span class="points">+${Number(msg.points) || 0}</span>` : "";
      return `<div class="msg correct${mine}"><span class="who">${esc(msg.name)}</span>${esc(msg.text)}${points}</div>`;
    }
    const kindCls = msg.kind === "drawer" ? " drawer" : " normal";
    return `<div class="msg${kindCls}${mine}"><span class="who">${esc(msg.name)}</span>${esc(msg.text)}</div>`;
  }

  function renderChat(forceBottom) {
    const html = messages.map(messageHtml).join("");
    for (const el of [$("chatList"), $("lobbyChat")]) {
      if (!el) continue;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      el.innerHTML = html;
      if (nearBottom || forceBottom) el.scrollTop = el.scrollHeight;
    }
  }

  function sendChat(input) {
    const text = input.value.trim();
    if (!text) return;
    socket.emit("guess", { text });
    input.value = "";
    input.focus();
  }

  for (const id of ["chatForm", "lobbyChatForm"]) {
    $(id).addEventListener("submit", (event) => {
      event.preventDefault();
      sendChat(id === "chatForm" ? $("chatInput") : $("lobbyChatInput"));
    });
  }

  // -------------------------------------------------------------- daftar pemain
  function playerById(id) {
    return room && room.players ? room.players.find((p) => p.id === id) || null : null;
  }

  function renderPlayers(el, players, opts = {}) {
    if (!el) return;
    const list = opts.sort ? players.slice().sort((a, b) => b.score - a.score) : players;
    el.innerHTML = list
      .map((p) => {
        const cls = ["player"];
        if (!p.connected) cls.push("offline");
        if (p.isDrawer) cls.push("is-drawer");
        const tags = [];
        if (p.isHost) tags.push('<span class="tag">host</span>');
        if (opts.ready && p.ready) tags.push('<span class="tag ready">siap</span>');
        if (p.id === myId) tags.push('<span class="tag">kamu</span>');
        const tick = opts.showTick && p.guessed && !p.isDrawer ? '<span class="tick" title="sudah menebak benar">✓</span>' : "";
        const offline = p.connected ? "" : '<span class="tag">offline</span>';
        return `<li class="${cls.join(" ")}">
          <span class="avatar" style="background:${colorFor(p.name)}">${esc((p.name || "?").slice(0, 1).toUpperCase())}</span>
          <span class="pname">${esc(p.name)}${tags.join("")}</span>
          ${tick}${offline}
          <span class="pscore">${Number(p.score) || 0}</span>
        </li>`;
      })
      .join("");
  }

  // --------------------------------------------------------------- render
  function turnKey(state) {
    return `${state.round}:${state.drawerId}`;
  }

  function render() {
    if (!room) return;
    $("roomChip").textContent = `Room ${room.code}`;
    if (room.phase === "lobby") {
      showScreen("lobby");
      renderLobby();
    } else {
      showScreen("game");
      renderGame();
    }
  }

  function renderLobby() {
    const me = playerById(myId);
    const isHost = room.hostId === myId;
    $("roomCode").textContent = room.code;
    $("playerCount").textContent = `${room.players.length}/10`;
    renderPlayers($("lobbyPlayers"), room.players, { ready: true });

    $("readyBtn").textContent = me && me.ready ? "Batal siap" : "Siap";
    $("readyBtn").classList.toggle("primary", !(me && me.ready));
    $("startBtn").disabled = !isHost || room.players.length < 2;
    $("themeSelect").disabled = !isHost;
    if (document.activeElement !== $("themeSelect")) {
      const theme = room.theme || "random";
      if ($("themeSelect").value !== theme) $("themeSelect").value = theme;
    }
    $("lobbyHint").textContent =
      room.players.length < 2
        ? "Butuh minimal 2 pemain untuk memulai."
        : isHost
          ? "Kamu host — pilih tema lalu mulai. Game berjalan 3 ronde."
          : "Menunggu host memulai permainan…";
  }

  function scoreHtml(players) {
    const list = (players || []).slice().sort((a, b) => b.score - a.score);
    return `<ol class="score-list">${list
      .map(
        (p, i) =>
          `<li class="${i === 0 && p.score > 0 ? "win" : ""}"><span>${i + 1}. ${esc(p.name)}</span><b>${Number(p.score) || 0}</b></li>`
      )
      .join("")}</ol>`;
  }

  const REASONS = {
    "waktu habis": "Waktu habis",
    "semua menebak": "Semua pemain menebak benar",
    "penggambar keluar": "Penggambar keluar",
  };

  function overlayHtml() {
    const phase = room.phase;
    const isDrawer = room.drawerId === myId;
    if (phase === "choosing") {
      if (isDrawer) {
        const options = (room.options || [])
          .map((w) => `<button class="word-option" data-word="${esc(w)}">${esc(w)}</button>`)
          .join("");
        return `<div class="overlay-card"><h3>Pilih kata untuk digambar</h3>
          <div class="word-options">${options}</div>
          <p class="muted small">Pilih otomatis dalam ${room.secondsLeft}s</p></div>`;
      }
      return `<div class="overlay-card"><h3>${esc(room.drawerName || "Seseorang")} sedang memilih kata…</h3>
        <p class="muted small">Bersiap menebak.</p></div>`;
    }
    if (phase === "turnEnd") {
      const word = room.lastTurn ? room.lastTurn.word : room.maskedWord;
      const reason = room.lastTurn ? REASONS[room.lastTurn.reason] || room.lastTurn.reason : "";
      return `<div class="overlay-card"><h3>Jawabannya</h3>
        <div class="answer">${esc(word)}</div>
        <p class="muted small">${esc(reason)}</p></div>`;
    }
    if (phase === "roundEnd") {
      return `<div class="overlay-card"><h3>Ronde ${room.round} selesai</h3>
        ${scoreHtml(room.scoreboard || room.players)}
        <p class="muted small">Ronde berikutnya segera dimulai…</p></div>`;
    }
    if (phase === "gameEnd") {
      const board = room.scoreboard || room.players;
      const winner = board.slice().sort((a, b) => b.score - a.score)[0];
      const isHost = room.hostId === myId;
      const actions = isHost
        ? '<button class="btn primary" data-action="again">Main lagi</button><button class="btn ghost" data-action="leave">Keluar</button>'
        : '<span class="muted small">Menunggu host memulai lagi…</span><button class="btn ghost" data-action="leave">Keluar</button>';
      return `<div class="overlay-card"><h3>🏆 ${esc(winner ? winner.name : "")} menang!</h3>
        ${scoreHtml(board)}
        <div class="overlay-actions">${actions}</div></div>`;
    }
    return null;
  }

  function renderGame() {
    const phase = room.phase;
    const isDrawer = room.drawerId === myId;

    $("roundNum").textContent = room.round || 1;
    $("roundTotal").textContent = room.totalRounds || 3;
    $("themeLabel").textContent = room.themeLabel ? `Tema: ${room.themeLabel}` : "";

    const total = Math.max(1, Number(room.turnTotal) || 1);
    const left = Math.max(0, Number(room.secondsLeft) || 0);
    const pct = Math.min(100, (left / total) * 100);
    $("timerBar").style.width = `${pct}%`;
    $("timerBar").parentElement.classList.toggle("low", pct <= 25);
    $("timerText").textContent = `${left}s`;

    let word = "—";
    if (phase === "choosing") word = "• • •";
    else if (phase === "drawing" || phase === "turnEnd") word = isDrawer && room.word ? room.word : room.maskedWord || "—";
    else if (phase === "roundEnd") word = "Ronde selesai";
    else if (phase === "gameEnd") word = "Permainan selesai";
    $("wordDisplay").textContent = word;
    $("drawerBadge").classList.toggle("hidden", !(phase === "drawing" && isDrawer));

    renderPlayers($("gamePlayers"), room.players, { sort: true, showTick: phase === "drawing" });

    $("toolbar").classList.toggle("hidden", !(phase === "drawing" && isDrawer));
    canvas.classList.toggle("readonly", !canDraw());
    $("chatInput").placeholder = isDrawer && phase === "drawing" ? "Kamu menggambar — kirim pesan…" : "Tebak kata di sini…";

    // Kanvas: kosongkan saat giliran baru, lalu pulihkan snapshot bila ada.
    const key = phase === "drawing" || phase === "turnEnd" ? turnKey(room) : null;
    if (key && key !== canvasKey) {
      canvasKey = key;
      clearCanvas();
      if (pendingSnapshot) {
        pendingSnapshot.forEach(applyOp);
        pendingSnapshot = null;
      }
    }

    const html = overlayHtml();
    const overlay = $("overlay");
    if (!html) {
      overlay.classList.add("hidden");
      lastOverlay = null;
    } else {
      overlay.classList.remove("hidden");
      if (html !== lastOverlay) {
        overlay.innerHTML = html;
        lastOverlay = html;
      }
    }
  }

  // ---------------------------------------------------------------- aksi UI
  $("createBtn").addEventListener("click", () => {
    const name = validName();
    if (!name) return;
    showJoinError("");
    $("createBtn").disabled = true;
    socket.emit("createRoom", { name }, (res) => {
      $("createBtn").disabled = false;
      handleAuth(res);
    });
  });

  $("joinBtn").addEventListener("click", () => {
    const name = validName();
    if (!name) return;
    const code = $("codeInput").value.trim().toUpperCase();
    if (code.length !== 4) {
      showJoinError("Kode room terdiri dari 4 karakter.");
      return;
    }
    showJoinError("");
    $("joinBtn").disabled = true;
    socket.emit("joinRoom", { code, name }, (res) => {
      $("joinBtn").disabled = false;
      handleAuth(res);
    });
  });

  $("nameInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("createBtn").click();
  });
  $("codeInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("joinBtn").click();
  });
  $("codeInput").addEventListener("input", () => {
    $("codeInput").value = $("codeInput").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  function validName() {
    const name = $("nameInput").value.trim().slice(0, 16);
    if (!name) {
      showJoinError("Isi nama dulu, ya.");
      $("nameInput").focus();
      return "";
    }
    return name;
  }

  function handleAuth(res) {
    if (!res || res.error) {
      showJoinError((res && res.error) || "Terjadi kesalahan. Coba lagi.");
      return;
    }
    myId = res.playerId;
    saveSession({ name: res.name, code: res.code });
    showJoinError("");
    $("codeInput").value = "";
    $("nameInput").value = res.name || $("nameInput").value;
  }

  function leaveRoom() {
    socket.emit("leaveRoom");
    room = null;
    myId = null;
    messages = [];
    canvasKey = null;
    pendingSnapshot = null;
    lastOverlay = null;
    clearSession();
    clearCanvas();
    $("roomChip").textContent = "";
    $("chatList").innerHTML = "";
    $("lobbyChat").innerHTML = "";
    $("overlay").classList.add("hidden");
    showScreen("join");
  }

  $("leaveLobby").addEventListener("click", leaveRoom);
  $("readyBtn").addEventListener("click", () => {
    const me = playerById(myId);
    socket.emit("setReady", { ready: !(me && me.ready) });
  });
  $("startBtn").addEventListener("click", () => {
    const theme = $("themeSelect").value || "random";
    $("startBtn").disabled = true;
    socket.emit("startGame", { theme }, (res) => {
      $("startBtn").disabled = false;
      if (res && res.error) $("lobbyHint").textContent = res.error;
    });
  });
  $("copyBtn").addEventListener("click", async () => {
    const code = room ? room.code : "";
    try {
      await navigator.clipboard.writeText(code);
      flashCopy("Tersalin!");
    } catch {
      flashCopy(`Kode: ${code}`);
    }
  });
  function flashCopy(text) {
    const btn = $("copyBtn");
    btn.textContent = text;
    setTimeout(() => {
      btn.textContent = "Salin kode";
    }, 1600);
  }

  $("overlay").addEventListener("click", (event) => {
    const wordBtn = event.target.closest("[data-word]");
    if (wordBtn) {
      socket.emit("pickWord", { word: wordBtn.dataset.word });
      return;
    }
    const action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "again") {
      action.disabled = true;
      socket.emit("playAgain", {}, (res) => {
        if (res && res.error) action.disabled = false;
      });
    }
    if (action.dataset.action === "leave") leaveRoom();
  });

  // ------------------------------------------------------------- socket
  function requestThemes() {
    socket.emit("themes", (res) => {
      if (!res || !res.themes) return;
      const select = $("themeSelect");
      const previous = select.value || "random";
      select.innerHTML =
        '<option value="random">Campuran (semua tema)</option>' +
        res.themes.map((theme) => `<option value="${esc(theme.key)}">${esc(theme.label)}</option>`).join("");
      select.value = previous;
    });
  }

  socket.on("connect", () => {
    $("connStatus").classList.add("hidden");
    requestThemes();
    const shouldRejoin = !!(session.name && session.code) && (disconnectHappened || !room);
    if (shouldRejoin) {
      socket.emit("joinRoom", { code: session.code, name: session.name }, (res) => {
        if (!res || res.error) {
          clearSession();
          if (currentScreen !== "join") {
            room = null;
            myId = null;
            showScreen("join");
            showJoinError("Room sebelumnya sudah tidak tersedia.");
          }
        } else {
          myId = res.playerId;
          saveSession({ name: res.name, code: res.code });
        }
      });
    }
    disconnectHappened = false;
  });

  socket.on("disconnect", () => {
    disconnectHappened = true;
    $("connStatus").classList.remove("hidden");
  });

  socket.on("connect_error", () => {
    $("connStatus").classList.remove("hidden");
  });

  socket.on("roomState", (state) => {
    if (!state) return;
    room = state;
    if (state.me) myId = state.me.id;
    render();
  });

  socket.on("chatHistory", (list) => {
    messages = Array.isArray(list) ? list.slice(-MAX_CHAT) : [];
    renderChat(true);
  });

  socket.on("chat", (msg) => {
    if (!msg) return;
    messages.push(msg);
    if (messages.length > MAX_CHAT) messages.shift();
    renderChat(true);
  });

  socket.on("draw", (op) => {
    if (!room || !["drawing", "turnEnd"].includes(room.phase)) return;
    applyOp(op);
  });

  socket.on("drawSnapshot", (ops) => {
    const list = Array.isArray(ops) ? ops : [];
    const key = room ? turnKey(room) : null;
    if (key && key === canvasKey) {
      clearCanvas();
      list.forEach(applyOp);
    } else {
      pendingSnapshot = list;
    }
  });

  // -------------------------------------------------------------- start
  clearCanvas();
  updateToolUi();
  requestThemes();
})();
