// Row detection stays in the page. This only opens that page and checks the crops.
// node test/loadout-rows.mjs
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 8765;
const DEBUG = 9222;

function spawnServer() {
  return spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitFetch(url) {
  let last;
  for (let i = 0; i < 50; i++) {
    try { return await fetch(url); }
    catch (err) { last = err; await delay(100); }
  }
  throw last;
}

const server = spawnServer();
const userDir = await mkdtemp(path.join(tmpdir(), "souls-chrome-"));
const chrome = spawn("google-chrome", [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  "--allow-insecure-localhost",
  `--remote-debugging-port=${DEBUG}`,
  `--user-data-dir=${userDir}`,
  "about:blank"
], { stdio: "ignore" });

let ws;
try {
  await waitFetch(`http://127.0.0.1:${PORT}/index.html`);
  const version = await (await waitFetch(`http://127.0.0.1:${DEBUG}/json/version`)).json();
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  function send(method, params = {}, sessionId) {
    const id = ++seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(payload));
    });
  }

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html?test=1` }, sessionId);

  let ready = false;
  for (let i = 0; i < 50; i++) {
    const probe = await send("Runtime.evaluate", {
      expression: "!!(window.SOULS && window.SOULS.findLoadout)",
      returnByValue: true
    }, sessionId);
    if (probe.result && probe.result.value) { ready = true; break; }
    await delay(100);
  }
  if (!ready) throw new Error("The page did not expose the loadout reader.");

  const evaluated = await send("Runtime.evaluate", {
    expression: `(() => {
      function load(src) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("Could not open " + src));
          img.src = src;
        });
      }
      function relCrop(img, found) {
        const w = img.naturalWidth, h = img.naturalHeight, r = found.rect;
        return {
          w, h,
          rect: r,
          anchorY: found.anchorY,
          rel: {
            x: r.x / w, y: r.y / h, w: r.w / w, h: r.h / h,
            right: (r.x + r.w) / w,
            anchor: found.anchorY / h
          }
        };
      }
      return (async () => {
        const example = await load("examples/loadout.jpg");
        const dark = await load("fixtures/loadout-dark-artifact.jpg");
        const formation = await load("examples/formation.jpg");
        function readRow(img, label) {
          try { return relCrop(img, window.SOULS.findLoadout(img)); }
          catch (e) { return { error: e.message || String(e), label: label }; }
        }
        function plateStats(img) {
          const plate = window.SOULS.findNamePlate(img);
          if (!plate) return { missing: true };
          const c = plate.canvas;
          const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
          let opaque = 0, red = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 200) continue;
            opaque++;
            const r = d[i], g = d[i + 1], b = d[i + 2];
            if (r > 150 && r > g + 40 && r > b + 25) red++;
          }
          return { rect: plate.rect, opaque: opaque, red: red, pw: c.width, ph: c.height };
        }
        const rows = {
          example: readRow(example, "example"),
          dark: readRow(dark, "dark")
        };
        const names = { example: plateStats(example), dark: plateStats(dark) };
        let formationError = "";
        try {
          window.SOULS.findLoadout(formation);
          formationError = "accepted";
        } catch (e) {
          formationError = e.message || String(e);
        }
        const form = window.SOULS.findFormation(formation);
        const share = [...document.querySelectorAll("[data-share]")].map((b) => ({ label: b.textContent, hidden: b.hidden, disabled: b.disabled }));
        return { rows, names, formationError, form, share };
      })();
    })()`,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);

  if (evaluated.exceptionDetails) {
    const ex = evaluated.exceptionDetails.exception;
    const desc = (ex && ex.description) || evaluated.exceptionDetails.text;
    console.log(JSON.stringify({ failed: true, error: desc }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(evaluated.result.value, null, 2));
    const value = evaluated.result.value;
    const expected = {
      example: { x: 21, y: 551, w: 427, h: 375, anchorY: 559 },
      dark: { x: 51, y: 1231, w: 1000, h: 879, anchorY: 1250 }
    };
    const nameExpected = {
      example: { x: 83, y: 74, w: 69, h: 15 },
      dark: { x: 197, y: 182, w: 164, h: 31 }
    };
    const problems = [];
    for (const [label, row] of Object.entries(value.rows)) {
      if (row.error) { problems.push(label + ": " + row.error); continue; }
      const exp = expected[label];
      const got = { ...row.rect, anchorY: row.anchorY };
      for (const key of Object.keys(exp)) {
        if (Math.abs(got[key] - exp[key]) > 4) problems.push(label + " " + key + " " + got[key]);
      }
      if ((row.rect.x + row.rect.w) / row.w < 0.95) problems.push(label + " misses the artifact");
      const plate = value.names[label];
      if (!plate || plate.missing) { problems.push(label + " name missing"); continue; }
      const want = nameExpected[label];
      for (const key of Object.keys(want)) {
        if (Math.abs(plate.rect[key] - want[key]) > 4) problems.push(label + " name " + key + " " + plate.rect[key]);
      }
      if (!plate.opaque || plate.red / plate.opaque > 0.05) problems.push(label + " name includes the red title");
      if (plate.pw / plate.ph < 3) problems.push(label + " name is not a text line");
    }
    const byLabel = Object.fromEntries((value.share || []).map((b) => [b.label, b]));
    if (!byLabel["Download PNG"] || byLabel["Download PNG"].hidden) problems.push("Download PNG is missing");
    if (!byLabel["Download PNG"].disabled) problems.push("Download PNG starts enabled");
    if (byLabel["Share image"] && byLabel["Share image"].hidden !== true) problems.push("Share image shows without navigator.share");
    if (byLabel["Copy image"] && byLabel["Copy image"].hidden) problems.push("Copy image is hidden in this Chrome");
    if (value.formationError !== "Could not find the five hero rows in that loadout.") {
      problems.push("formation: " + value.formationError);
    }
    const form = value.form;
    const fw = 460, fh = 1024;
    if (Math.abs(form.x / fw - 0.13) > 0.02 || Math.abs(form.y / fh - 0.094) > 0.02) {
      problems.push("formation crop shifted");
    }
    async function evalJs(expression, sid) {
      const out = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid || sessionId);
      if (out.exceptionDetails) {
        const ex = out.exceptionDetails.exception;
        throw new Error((ex && ex.description) || out.exceptionDetails.text);
      }
      return out.result.value;
    }
    async function waitFor(pred, sid, label) {
      for (let i = 0; i < 80; i++) {
        if (await evalJs(pred, sid)) return;
        await delay(250);
      }
      throw new Error(label || "timed out");
    }
    if (!problems.length) {
      await evalJs(`(async () => {
        async function use(id, src, name) {
          const blob = await (await fetch(src)).blob();
          const file = new File([blob], name, { type: blob.type || "image/jpeg" });
          const input = document.getElementById(id);
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await use("file-battle", "examples/formation.jpg", "battle.jpg");
        await new Promise((r) => setTimeout(r, 200));
        await use("file-lineup", "examples/loadout.jpg", "loadout.jpg");
      })()`);
      await waitFor(`(() => {
        const dl = document.querySelector('[data-share="dl"]');
        const msg = document.querySelector(".share-msg").textContent;
        return document.getElementById("card").height > 200 && dl && !dl.disabled && msg.indexOf("Preparing") !== 0;
      })()`, sessionId, "example card did not finish");
      const readyMsg = await evalJs(`document.getElementById("status").textContent`);
      if (readyMsg) problems.push("example status: " + readyMsg);
      await evalJs(`(() => {
        const Orig = window.ClipboardItem;
        let sawPromise = false;
        window.ClipboardItem = function (items) {
          sawPromise = items["image/png"] instanceof Promise;
          return new Orig(items);
        };
        window.ClipboardItem.supports = Orig.supports.bind(Orig);
        navigator.clipboard.write = async (items) => {
          const blob = await items[0].getType("image/png");
          window.__copied = { type: blob.type, size: blob.size, promise: sawPromise };
        };
      })()`);
      await evalJs(`document.querySelector('[data-share="copy"]').click()`);
      await waitFor(`window.__copied && window.__copied.size > 1000`, sessionId, "copy did not produce a png");
      const copied = await evalJs(`({ copied: window.__copied, msg: document.querySelector(".share-msg").textContent })`);
      if (!copied.copied.promise) problems.push("copy did not pass a promise into ClipboardItem");
      if (copied.copied.type !== "image/png") problems.push("copy type " + copied.copied.type);
      if (copied.msg !== "Copied. Paste it into Discord.") problems.push("copy message: " + copied.msg);
      await evalJs(`(() => {
        navigator.clipboard.write = () => { const err = new Error("cancelled"); err.name = "AbortError"; return Promise.reject(err); };
      })()`);
      await evalJs(`document.querySelector('[data-share="copy"]').click()`);
      await waitFor(`document.querySelector(".share-msg").textContent === "" && !document.querySelector('[data-share="copy"]').hidden`, sessionId, "cancel did not clear the copy message");
      await evalJs(`(() => {
        navigator.clipboard.write = () => { const err = new Error("denied"); err.name = "NotAllowedError"; return Promise.reject(err); };
      })()`);
      await evalJs(`document.querySelector('[data-share="copy"]').click()`);
      await waitFor(`document.querySelector('[data-share="copy"]').hidden`, sessionId, "refused copy stayed visible");
      const refused = await evalJs(`document.querySelector(".share-msg").textContent`);
      if (refused !== "This browser does not let a page copy a picture. Use Download PNG.") problems.push("refusal: " + refused);
      await evalJs(`document.querySelector('[data-share="dl"]').click()`);
      await waitFor(`document.querySelector(".share-msg").textContent.indexOf("Saved as souls-comp-card.png.") === 0`, sessionId, "download message missing");

      const mobileSource = `navigator.share = function (data) {
        const file = data && data.files && data.files[0];
        window.__shared = { name: file && file.name, type: file && file.type, title: data && data.title, size: file && file.size };
        if (window.__shareMode === "abort") { const err = new Error("cancelled"); err.name = "AbortError"; return Promise.reject(err); }
        return Promise.resolve();
      };
      navigator.canShare = function () { return window.__shareMode !== "nocan"; };
      if (window.ClipboardItem) window.ClipboardItem.supports = function () { return false; };`;
      const { targetId: mobileId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId: mobile } = await send("Target.attachToTarget", { targetId: mobileId, flatten: true });
      await send("Page.enable", {}, mobile);
      await send("Runtime.enable", {}, mobile);
      await send("Page.addScriptToEvaluateOnNewDocument", { source: mobileSource }, mobile);
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, mobile);
      await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` }, mobile);
      await waitFor(`!!document.querySelector('[data-share="dl"]')`, mobile, "mobile page did not load");
      const mobileButtons = await evalJs(`JSON.stringify([...document.querySelectorAll("[data-share]")].map((b) => ({ label: b.textContent, hidden: b.hidden })))`, mobile);
      const mobileList = JSON.parse(mobileButtons);
      const mobileBy = Object.fromEntries(mobileList.map((b) => [b.label, b]));
      if (!mobileBy["Share image"] || mobileBy["Share image"].hidden) problems.push("phone emulation did not offer Share image: " + mobileButtons);
      if (mobileBy["Copy image"] && !mobileBy["Copy image"].hidden) problems.push("phone emulation still offered Copy image");
      const fits = await evalJs(`(() => { const el = document.querySelector(".share").getBoundingClientRect(); return el.width <= document.documentElement.clientWidth + 1; })()`, mobile);
      if (!fits) problems.push("share row is wider than a phone");
      await evalJs(`(async () => {
        async function use(id, src, name) {
          const blob = await (await fetch(src)).blob();
          const file = new File([blob], name, { type: blob.type || "image/jpeg" });
          const input = document.getElementById(id);
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await use("file-battle", "examples/formation.jpg", "battle.jpg");
        await new Promise((r) => setTimeout(r, 200));
        await use("file-lineup", "examples/loadout.jpg", "loadout.jpg");
      })()`, mobile);
      await waitFor(`(() => { const b = document.querySelector('[data-share="native"]'); return b && !b.hidden && !b.disabled; })()`, mobile, "mobile share stayed disabled");
      await evalJs(`document.querySelector('[data-share="native"]').click()`, mobile);
      await waitFor(`window.__shared && window.__shared.size > 1000`, mobile, "share did not send a png");
      const shared = await evalJs(`window.__shared`, mobile);
      if (shared.name !== "souls-comp-card.png" || shared.type !== "image/png" || shared.title !== "SOULS Comp Card") problems.push("share payload " + JSON.stringify(shared));
      const msg = await evalJs(`document.querySelector(".share-msg").textContent`, mobile);
      if (msg !== "Shared.") problems.push("share message: " + msg);
      await evalJs(`window.__shareMode = "abort"; document.querySelector('[data-share="native"]').click()`, mobile);
      await waitFor(`document.querySelector(".share-msg").textContent === ""`, mobile, "cancelling share left a message");
      await evalJs(`window.__shareMode = "nocan"; window.__shared = null; document.querySelector('[data-share="native"]').click()`, mobile);
      await waitFor(`document.querySelector(".share-msg").textContent.indexOf("cannot share") >= 0`, mobile, "canShare failure had no fallback");
      const fallback = await evalJs(`document.querySelector(".share-msg").innerText`, mobile);
      if (fallback.indexOf("press and hold") < 0) problems.push("fallback: " + fallback);
    }
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
    } else {
      console.log("PASS");
    }
  }
} finally {
  if (ws) ws.close();
  chrome.kill("SIGKILL");
  server.kill("SIGKILL");
  await delay(200);
  await rm(userDir, { recursive: true, force: true }).catch(() => {});
}
