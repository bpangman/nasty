"use strict";
/*
 * Blake's follow-up (2026-07-24, same batch as the topbar symmetry fix): "give me the option
 * to set the cpu difficulty when playing an online game."
 *
 * Investigation finding (see HANDOFF.md for the full writeup): the wire/protocol already
 * carried per-seat difficulty end to end before this session touched anything - the `host`
 * message's seats:[{name,type,diff}], room.lobby.seats, lobbySnapshot(), the host-only setSeat
 * {patch:{diff}} case (server.js/server.ts), and actuallyStartGame()'s seatsCfg building were
 * ALL already wired (takeOverSeat, the reunion lobby's "have a computer take over" picker,
 * already sent a diff and it already worked). The gap was purely a missing lobby UI: nothing
 * ever rendered a control to CHANGE a CPU seat's difficulty before the game started, and no
 * screen showed the current value to a guest either.
 *
 * This suite proves the FIX end to end through the REAL UI (not mocked): the host can change a
 * CPU seat's difficulty from the room screen using the existing Easy/Tricky/Nasty tier names;
 * every guest sees the current tier on their own seat screen (read-only); a non-host client
 * cannot change it (client has no control to change it AND the server independently refuses
 * the message even if sent directly); the started game's real G.seats carry the chosen diff
 * (so the CPU actually plays at that tier, not just a display value); and the server rejects
 * a garbage diff value rather than storing it verbatim.
 *
 * Usage: node test_online_cpu_difficulty.js node     (server/server.js)
 *        node test_online_cpu_difficulty.js deno     (server/cloud/server.ts)
 *
 * Never touches prod - a single private server instance, random port, scratch
 * NASTY_ROOMS_DIR/NASTY_KV_PATH, throwaway admin token - same discipline as every other suite.
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
const PORT = 24600 + Math.floor(Math.random() * 400);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-cpudiff-${KIND}-`));

function log(...a) { console.log("[cpudiff]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port) {
  if (USE_DENO) {
    return spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(SCRATCH, "cpudiff.kv"), NASTY_ADMIN_TOKEN: "cpudiff-admin-token" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(process.execPath, ["server.js"], {
    cwd: "/Users/jarvis/nasty-game/server",
    env: Object.assign({}, process.env, {
      NASTY_PORT: String(port), NASTY_ROOMS_DIR: SCRATCH,
      NASTY_ADMIN_TOKEN_FILE: path.join(SCRATCH, "admin-token.txt"),
      NASTY_LEADERBOARD_FILE: path.join(SCRATCH, "leaderboard.json"),
      NASTY_LEADERBOARD_EPOCH_FILE: path.join(SCRATCH, "leaderboard-epoch.json"),
      NASTY_SOLO_IDS_FILE: path.join(SCRATCH, "solo-ids.json"),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function waitHealthy(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return; } catch (e) {}
    await sleep(400);
  }
  throw new Error("server never became healthy");
}
async function newPage(ctx, wsPort) {
  const page = await ctx.newPage();
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(String(e)));
  await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(`ws://127.0.0.1:${wsPort}`)}`);
  await page.waitForFunction(() => typeof window.NET === "object");
  await page.evaluate(() => { try { localStorage.setItem("nasty-speed-chosen", "1"); } catch (e) {} });
  return page;
}
async function openHostSetup(page, seatMetaByN) {
  await page.evaluate((seatMetaByN) => {
    Object.keys(seatMetaByN).forEach((n) => { CFG.seatMeta[n] = seatMetaByN[n]; });
  }, seatMetaByN);
  await page.evaluate(() => document.getElementById("btnOnline").click());
  await page.evaluate(() => document.getElementById("btnHostGame").click());
  await page.waitForFunction(() => !document.getElementById("hostSpeedOverlay").classList.contains("hidden"), { timeout: 5000 });
}
async function pickSpeedAndAwaitCreated(page, speedSubstr) {
  return page.evaluate((speedSubstr) => new Promise((resolve, reject) => {
    const orig = window.handleNetMessage;
    window.handleNetMessage = function (m) {
      orig(m);
      if (m.type === "created") { window.handleNetMessage = orig; resolve(m.code); }
      else if (m.type === "error") { window.handleNetMessage = orig; reject(new Error("host create failed: " + m.message)); }
    };
    const btns = [...document.querySelectorAll("#hostSpeedBtns button")];
    const btn = btns.find((b) => b.textContent.startsWith(speedSubstr));
    if (!btn) { reject(new Error(`"${speedSubstr}" speed button not found`)); return; }
    btn.click();
  }), speedSubstr);
}
async function dismissOnlineRules(page) {
  await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
}
async function joinAsGuest(page, code, name) {
  await page.evaluate(() => document.getElementById("btnOnline").click());
  await page.evaluate(() => document.getElementById("btnJoinGame").click());
  await page.evaluate((code) => { document.getElementById("joinCodeInput").value = code; }, code);
  await page.evaluate(() => document.getElementById("btnJoinCodeNext").click());
  await page.evaluate((name) => { document.getElementById("joinNameInput").value = name; }, name);
  await page.evaluate(() => document.getElementById("btnJoinNameNext").click());
  await page.waitForFunction(() => window.NET && window.NET.lobby != null, { timeout: 8000 });
}
// Reads the host's own room screen's CPU-seat <select> (by seat's current name, since color
// names are stable across a run) - the current selected tier value and the visible options.
async function readHostDiffSelect(page, seatName) {
  return page.evaluate((seatName) => {
    const rows = [...document.querySelectorAll("#roomSeatList .lobbySeat")];
    const row = rows.find((r) => r.querySelector(".nm") && r.querySelector(".nm").textContent === seatName);
    if (!row) return null;
    const sel = row.querySelector("select");
    if (!sel) return { hasSelect: false };
    return {
      hasSelect: true,
      value: sel.value,
      options: [...sel.options].map((o) => ({ value: o.value, text: o.textContent })),
    };
  }, seatName);
}
async function setHostDiffSelect(page, seatName, value) {
  return page.evaluate(({ seatName, value }) => {
    const rows = [...document.querySelectorAll("#roomSeatList .lobbySeat")];
    const row = rows.find((r) => r.querySelector(".nm") && r.querySelector(".nm").textContent === seatName);
    if (!row) return false;
    const sel = row.querySelector("select");
    if (!sel) return false;
    sel.value = value;
    sel.dispatchEvent(new Event("change"));
    return true;
  }, { seatName, value });
}
// Guest's read-only view: a .diffLabel span next to the seat name, no <select> anywhere.
async function readGuestDiffLabel(page, seatName) {
  return page.evaluate((seatName) => {
    const rows = [...document.querySelectorAll("#joinSeatList .lobbySeat")];
    const row = rows.find((r) => r.querySelector(".nm") && r.querySelector(".nm").textContent === seatName);
    if (!row) return null;
    const lbl = row.querySelector(".diffLabel");
    return { hasSelect: !!row.querySelector("select"), labelText: lbl ? lbl.textContent : null };
  }, seatName);
}

async function main() {
  const child = startServer(PORT);
  child.stderr.on("data", (d) => { const s = String(d); if (!s.includes("Listening")) process.stderr.write("[server-err] " + s); });
  await waitHealthy(PORT);
  const browser = await chromium.launch();

  /* ===================================================================================
   * Scenario A - host changes a CPU seat's difficulty through the real lobby UI; a guest who
   * joins afterward sees the CURRENT tier read-only; the started game's real seats carry it.
   * =================================================================================== */
  log("--- Scenario A: host sets each CPU seat tier, guest sees it, game deals at that tier ---");
  {
    const ctxH = await browser.newContext({ reducedMotion: "reduce" });
    const ctxG = await browser.newContext({ reducedMotion: "reduce" });
    const host = await newPage(ctxH, PORT);
    const guest = await newPage(ctxG, PORT);

    const seatMeta4 = [
      { name: "Ann", type: "human", diff: "medium" }, { name: "Bo", type: "human", diff: "medium" },
      { name: "Cpu1", type: "cpu", diff: "medium" }, { name: "Cpu2", type: "cpu", diff: "medium" },
    ];
    await openHostSetup(host, { 4: seatMeta4 });
    const code = await pickSpeedAndAwaitCreated(host, "Fast");
    await dismissOnlineRules(host);

    // Default tier on a freshly-hosted CPU seat matches what was sent in seatMeta ("medium" =
    // Tricky) - the select must reflect the REAL current server-side value, not just default
    // to the first option.
    let sel = await readHostDiffSelect(host, "Cpu1");
    check(sel && sel.hasSelect, "A: host's room screen shows a real <select> for a CPU seat");
    check(sel && sel.value === "medium", `A: it starts on the seat's actual current tier (medium/Tricky) - got "${sel && sel.value}"`);
    check(sel && sel.options.length === 3 &&
      sel.options[0].value === "easy" && sel.options[0].text === "Easy" &&
      sel.options[1].value === "medium" && sel.options[1].text === "Tricky" &&
      sel.options[2].value === "hard" && sel.options[2].text === "Nasty",
      `A: the three options are the app's own tier names/mapping (easy/Easy, medium/Tricky, hard/Nasty) - got ${JSON.stringify(sel && sel.options)}`);

    // Host changes Cpu1 to Nasty (hard) and Cpu2 to Easy - real select interaction, real
    // change event, real setSeat message, waits for the server's lobby echo like every other
    // host-side lobby edit in this app.
    await setHostDiffSelect(host, "Cpu1", "hard");
    await host.waitForFunction(() => {
      const s = (window.NET.lobby.seats || []).find((s) => s.name === "Cpu1");
      return s && s.diff === "hard";
    }, { timeout: 5000 });
    await setHostDiffSelect(host, "Cpu2", "easy");
    await host.waitForFunction(() => {
      const s = (window.NET.lobby.seats || []).find((s) => s.name === "Cpu2");
      return s && s.diff === "easy";
    }, { timeout: 5000 });
    check(true, "A: host successfully set Cpu1->Nasty and Cpu2->Easy via the real dropdowns");

    // A guest joining AFTER the change sees the CURRENT tier, read-only (no select at all).
    await joinAsGuest(guest, code, "Bo");
    await dismissOnlineRules(guest);
    const guestCpu1 = await readGuestDiffLabel(guest, "Cpu1");
    const guestCpu2 = await readGuestDiffLabel(guest, "Cpu2");
    check(guestCpu1 && !guestCpu1.hasSelect && guestCpu1.labelText === "Nasty", `A: guest sees Cpu1's tier as read-only "Nasty" text, no dropdown - got ${JSON.stringify(guestCpu1)}`);
    check(guestCpu2 && !guestCpu2.hasSelect && guestCpu2.labelText === "Easy", `A: guest sees Cpu2's tier as read-only "Easy" text, no dropdown - got ${JSON.stringify(guestCpu2)}`);

    // Guest claims Bo, readies up, host starts - the REAL dealt game's G.seats must carry the
    // exact tiers chosen, not just the lobby display value (this is what makes the CPU actually
    // PLAY at that tier - chooseAI() reads G.seats[seat].diff, see index.html § AI).
    const claimed = await guest.evaluate(() => {
      const rows = [...document.querySelectorAll("#joinSeatList .lobbySeat")];
      const row = rows.find((r) => r.textContent.includes("Bo") && r.classList.contains("open"));
      if (!row) return false;
      row.click();
      return true;
    });
    check(claimed, "A: guest claimed the Bo seat via a real row click");
    await guest.waitForFunction(() => { const b = document.getElementById("btnJoinReady"); return b && !b.classList.contains("hidden"); }, { timeout: 5000 });
    await guest.evaluate(() => document.getElementById("btnJoinReady").click());
    await host.waitForFunction(() => !document.getElementById("btnRoomStart").disabled, { timeout: 5000 });
    await host.evaluate(() => document.getElementById("btnRoomStart").click());
    await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));

    const hostSeats = await host.evaluate(() => window.G.seats.map((s) => ({ name: s.name, type: s.type, diff: s.diff })));
    const guestSeats = await guest.evaluate(() => window.G.seats.map((s) => ({ name: s.name, type: s.type, diff: s.diff })));
    const cpu1H = hostSeats.find((s) => s.name === "Cpu1"), cpu2H = hostSeats.find((s) => s.name === "Cpu2");
    check(cpu1H && cpu1H.type === "cpu" && cpu1H.diff === "hard", `A: the REAL started game's Cpu1 seat is a CPU at hard/Nasty on the host - got ${JSON.stringify(cpu1H)}`);
    check(cpu2H && cpu2H.type === "cpu" && cpu2H.diff === "easy", `A: ...and Cpu2 at easy/Easy on the host - got ${JSON.stringify(cpu2H)}`);
    const cpu1G = guestSeats.find((s) => s.name === "Cpu1"), cpu2G = guestSeats.find((s) => s.name === "Cpu2");
    check(cpu1G && cpu1G.diff === "hard" && cpu2G && cpu2G.diff === "easy", `A: identically on the GUEST (deterministic lockstep, same seatsCfg from the server) - got ${JSON.stringify({ cpu1G, cpu2G })}`);
    check((host.__errors || []).length === 0 && (guest.__errors || []).length === 0, "A: zero page errors through the whole real-UI flow");

    await ctxH.close(); await ctxG.close();
  }

  /* ===================================================================================
   * Scenario B - a non-host cannot change a CPU seat's difficulty: (1) the guest's own seat
   * screen has no select control at all to even try, and (2) even a direct, hand-crafted
   * setSeat message sent as the guest is refused server-side (defense in depth, not just a
   * client-side gate).
   * =================================================================================== */
  log("--- Scenario B: a non-host cannot change CPU difficulty (no UI + server refuses direct message) ---");
  {
    const ctxH = await browser.newContext({ reducedMotion: "reduce" });
    const ctxG = await browser.newContext({ reducedMotion: "reduce" });
    const host = await newPage(ctxH, PORT);
    const guest = await newPage(ctxG, PORT);
    const seatMeta4 = [
      { name: "Host1", type: "human", diff: "medium" }, { name: "Gst1", type: "human", diff: "medium" },
      { name: "CpuA", type: "cpu", diff: "medium" }, { name: "CpuB", type: "cpu", diff: "medium" },
    ];
    await openHostSetup(host, { 4: seatMeta4 });
    const code = await pickSpeedAndAwaitCreated(host, "Normal");
    await dismissOnlineRules(host);
    await joinAsGuest(guest, code, "Gst1");
    await dismissOnlineRules(guest);

    const guestCpuA = await readGuestDiffLabel(guest, "CpuA");
    check(guestCpuA && !guestCpuA.hasSelect, "B: guest's own seat screen has NO <select> for any CPU seat (nothing to even tap)");

    // Even a hand-crafted setSeat sent directly over the guest's own socket must be refused -
    // the server keys off room.hostPlayerId, not "did the client show a control".
    await guest.evaluate(() => {
      const idx = (window.NET.lobby.seats || []).findIndex((s) => s.name === "CpuA");
      netSend({ type: "setSeat", seatIndex: idx, patch: { diff: "hard" } });
    });
    await sleep(400);   // give the server a moment to (not) act and (not) broadcast
    const stillMedium = await host.evaluate(() => {
      const s = (window.NET.lobby.seats || []).find((s) => s.name === "CpuA");
      return s && s.diff === "medium";
    });
    check(stillMedium, "B: a direct setSeat sent by the guest is refused server-side - CpuA is still medium/Tricky");

    // Sanity: the HOST can still change it right after, proving the refusal was about WHO
    // sent it, not that setSeat/diff patches are broken outright.
    await setHostDiffSelect(host, "CpuA", "hard");
    await host.waitForFunction(() => {
      const s = (window.NET.lobby.seats || []).find((s) => s.name === "CpuA");
      return s && s.diff === "hard";
    }, { timeout: 5000 });
    check(true, "B: the HOST's own change to the same seat still works fine right after");

    await ctxH.close(); await ctxG.close();
  }

  /* ===================================================================================
   * Scenario C - the server refuses a garbage diff value on setSeat rather than storing it
   * verbatim (the same allowlist takeOverSeat already enforced, now shared by setSeat too).
   * =================================================================================== */
  log("--- Scenario C: server rejects a garbage diff value on setSeat ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta4 = [
      { name: "Solo", type: "human", diff: "medium" }, { name: "CpuX", type: "cpu", diff: "medium" },
      { name: "CpuY", type: "cpu", diff: "medium" }, { name: "CpuZ", type: "cpu", diff: "medium" },
    ];
    await openHostSetup(page, { 4: seatMeta4 });
    await pickSpeedAndAwaitCreated(page, "Normal");
    await dismissOnlineRules(page);
    await page.evaluate(() => {
      const idx = (window.NET.lobby.seats || []).findIndex((s) => s.name === "CpuX");
      netSend({ type: "setSeat", seatIndex: idx, patch: { diff: "IMPOSSIBRU" } });
    });
    await sleep(400);
    const diffAfter = await page.evaluate(() => (window.NET.lobby.seats || []).find((s) => s.name === "CpuX").diff);
    check(diffAfter === "medium", `C: a garbage diff value is rejected outright, the seat keeps its last real value - got "${diffAfter}"`);
    check((page.__errors || []).length === 0, "C: zero page errors");
    await ctx.close();
  }

  await browser.close();
  child.kill("SIGTERM");
  await sleep(400);
  log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

const WATCHDOG_MS = 150000;
const watchdog = setTimeout(() => {
  console.error(`[cpudiff] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
