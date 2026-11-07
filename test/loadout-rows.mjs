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
        const rows = {
          example: readRow(example, "example"),
          dark: readRow(dark, "dark")
        };
        let formationError = "";
        try {
          window.SOULS.findLoadout(formation);
          formationError = "accepted";
        } catch (e) {
          formationError = e.message || String(e);
        }
        const form = window.SOULS.findFormation(formation);
        return { rows, formationError, form };
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
    const problems = [];
    for (const [label, row] of Object.entries(value.rows)) {
      if (row.error) { problems.push(label + ": " + row.error); continue; }
      const exp = expected[label];
      const got = { ...row.rect, anchorY: row.anchorY };
      for (const key of Object.keys(exp)) {
        if (Math.abs(got[key] - exp[key]) > 4) problems.push(label + " " + key + " " + got[key]);
      }
      if ((row.rect.x + row.rect.w) / row.w < 0.95) problems.push(label + " misses the artifact");
    }
    if (value.formationError !== "Could not find the five hero rows in that loadout.") {
      problems.push("formation: " + value.formationError);
    }
    const form = value.form;
    const fw = 460, fh = 1024;
    if (Math.abs(form.x / fw - 0.13) > 0.02 || Math.abs(form.y / fh - 0.094) > 0.02) {
      problems.push("formation crop shifted");
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
