/**
 * Uji UI di Chrome sungguhan (headless) dengan dua tab pemain.
 * Butuh Chrome/Chromium terpasang. Jalankan: npm run test:ui
 * Lewatkan dengan: SKIP_UI=1
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const puppeteer = require("puppeteer-core");

const PORT = 4398;
const URL = `http://localhost:${PORT}/`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

let server = null;
let serverLog = "";
const pages = [];

function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server", "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CHOOSE_MS: "4000",
      TURN_END_MS: "400",
      ROUND_END_MS: "600",
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

async function waitForEither(list, predicate, label, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const page of list) {
      if (await page.evaluate(predicate).catch(() => false)) return page;
    }
    await sleep(80);
  }
  const diag = [];
  for (const page of list) {
    diag.push(
      await page
        .evaluate(() => ({
          screen: document.getElementById("screen-game").className,
          hidden: document.getElementById("overlay").classList.contains("hidden"),
          opts: document.querySelectorAll(".word-option").length,
          overlay: document.getElementById("overlay").textContent.slice(0, 60),
          word: document.getElementById("wordDisplay").textContent,
        }))
        .catch((error) => "eval error: " + error.message)
    );
  }
  throw new Error(`Timeout UI: ${label} :: ${JSON.stringify(diag)}`);
}

async function waitForClient(page, predicate, label, timeout = 8000) {
  try {
    await page.waitForFunction(predicate, { timeout, polling: 80 });
  } catch {
    throw new Error(`Timeout UI: ${label}`);
  }
}

async function inkPixels(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById("board");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4 * 53) {
      if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) ink++;
    }
    return ink;
  });
}

async function drawStroke(page) {
  const box = await (await page.$("#board")).boundingBox();
  const x = box.x + box.width * 0.25;
  const y = box.y + box.height * 0.3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(x + i * 14, y + Math.sin(i / 2) * 26);
  }
  await page.mouse.up();
}

async function sendGuess(page, text) {
  await page.evaluate((value) => {
    const input = document.getElementById("chatInput");
    input.value = value;
    document.getElementById("chatForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  }, text);
}

(async () => {
  if (process.env.SKIP_UI === "1") {
    console.log("↷ Uji UI dilewati (SKIP_UI=1).");
    return;
  }
  const executablePath = chromePath();
  if (!executablePath) {
    console.log("↷ Uji UI dilewati: Chrome/Chromium tidak ditemukan (set CHROME_PATH).");
    return;
  }

  const errors = [];
  let browser = null;
  try {
    startServer();
    await sleep(900);

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });

    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    for (const ctx of [ctxA, ctxB]) {
      const page = await ctx.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error" && !/favicon|Failed to load resource/i.test(msg.text())) {
          errors.push(`console: ${msg.text()}`);
        }
      });
      await page.goto(URL, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#screen-join:not(.hidden)");
      pages.push(page);
    }
    const [ana, budi] = pages;

    // --- join & lobby
    await ana.type("#nameInput", "Ana");
    await ana.click("#createBtn");
    await ana.waitForSelector("#screen-lobby:not(.hidden)");
    const code = await ana.$eval("#roomCode", (el) => el.textContent.trim());
    assert.strictEqual(code.length, 4, "kode room tampil 4 karakter");

    await budi.type("#nameInput", "Budi");
    await budi.type("#codeInput", code);
    await budi.click("#joinBtn");
    await budi.waitForSelector("#screen-lobby:not(.hidden)");
    await ana.waitForFunction(() => document.querySelectorAll("#lobbyPlayers .player").length === 2, { timeout: 6000 });

    const options = await ana.$$eval("#themeSelect option", (els) => els.map((el) => el.value));
    assert.ok(options.includes("hewan") && options.includes("makanan"), "tema dataset termuat di dropdown");

    await ana.select("#themeSelect", "hewan");

    // --- mulai permainan
    await ana.click("#startBtn");
    await ana.waitForSelector("#screen-game:not(.hidden)");

    let turns = 0;
    let lastRound = 0;
    // 3 ronde × 2 pemain = 6 giliran.
    while (turns < 6) {
      const drawer = await waitForEither(
        pages,
        () => !document.getElementById("overlay").classList.contains("hidden") &&
          document.querySelectorAll(".word-option").length > 0,
        "overlay pilih kata"
      );
      const guesser = pages.find((p) => p !== drawer);
      const round = Number(await drawer.$eval("#roundNum", (el) => el.textContent));
      lastRound = round;

      // penggambar memilih kata
      await drawer.evaluate(() => document.querySelector(".word-option").click());
      await drawer.waitForSelector("#toolbar:not(.hidden)");
      await waitForClient(
        guesser,
        () => /_/.test(document.getElementById("wordDisplay").textContent),
        "kata penebak disamarkan"
      );
      assert.strictEqual(
        await guesser.$eval("#toolbar", (el) => el.classList.contains("hidden")),
        true,
        "penebak tidak mendapat toolbar gambar"
      );

      const word = (await drawer.$eval("#wordDisplay", (el) => el.textContent)).trim();
      assert.ok(word && !word.includes("_"), "penggambar melihat kata asli");

      // gambar & pastikan tampil di layar penebak
      await drawStroke(drawer);
      await sleep(250);
      assert.ok((await inkPixels(drawer)) > 0, "goresan penggambar muncul di kanvasnya");
      assert.ok((await inkPixels(guesser)) > 0, "goresan diteruskan ke kanvas penebak");

      // penebak salah lalu benar
      await sendGuess(guesser, "bukan ini");
      await guesser.waitForFunction(
        () => [...document.querySelectorAll("#chatList .msg")].some((m) => m.textContent.includes("bukan ini")),
        { timeout: 6000 }
      );
      await sendGuess(guesser, word.toUpperCase());
      await guesser.waitForFunction(
        () => [...document.querySelectorAll("#chatList .msg.correct")].some((m) => /\+\d+/.test(m.textContent)),
        { timeout: 6000 }
      );
      await drawer.waitForFunction(
        () => document.querySelector("#overlay .answer") !== null,
        { timeout: 8000 }
      );
      await guesser.waitForFunction(
        () => document.querySelector("#overlay .answer") !== null,
        { timeout: 8000 }
      );
      assert.strictEqual(
        (await drawer.$eval("#overlay .answer", (el) => el.textContent)).trim(),
        word,
        "jawaban diumumkan saat giliran berakhir"
      );
      turns++;
    }

    assert.strictEqual(turns, 6, "6 giliran selesai (3 ronde x 2 pemain)");
    assert.strictEqual(lastRound, 3, "ronde terakhir adalah ronde 3");

    await ana.waitForFunction(
      () => document.querySelector("#overlay") && document.querySelector("#overlay").textContent.includes("menang"),
      { timeout: 12000 }
    );
    assert.strictEqual(
      (await ana.$eval("#wordDisplay", (el) => el.textContent)).trim(),
      "Permainan selesai"
    );
    const scores = await ana.$$eval("#gamePlayers .pscore", (els) => els.map((el) => Number(el.textContent)));
    assert.ok(scores.length === 2 && scores.every((s) => s > 0), "semua pemain punya skor > 0");

    // --- main lagi
    await ana.evaluate(() => document.querySelector('[data-action="again"]').click());
    await ana.waitForSelector("#screen-lobby:not(.hidden)", { timeout: 6000 });
    await budi.waitForSelector("#screen-lobby:not(.hidden)", { timeout: 6000 });
    await ana.waitForFunction(() => document.querySelectorAll("#lobbyPlayers .player").length === 2);

    assert.deepStrictEqual(errors, [], "tidak ada error di konsol browser");
    console.log("✔ UI lulus: join, lobby, 3 ronde, gambar, tebakan, skor, dan main lagi — tanpa error konsol.");
    await browser.close();
    server.kill();
    process.exit(0);
  } catch (error) {
    console.error("✘ UI gagal:", error.message);
    console.error(error.stack);
    if (errors.length) console.error("--- error browser ---\n" + errors.join("\n"));
    if (serverLog.trim()) console.error("--- log server ---\n" + serverLog.trim());
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    process.exit(1);
  }
})();
