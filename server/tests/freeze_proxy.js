"use strict";
/*
 * v0.22 freeze proxy - a tiny TCP proxy that can silently STOP forwarding while keeping every
 * connection open. This reproduces, at the network layer, the exact iOS/WKWebView zombie shape
 * the reconnect research doc documents (WebKit bug 228296 family): the socket still reports
 * OPEN on both ends, no close event ever fires, but messages sent during the freeze are
 * permanently lost to the frozen side. Stronger than the older in-page monkey-patch
 * (test_recalibration.js's freezeSocketOpen) because the client code path is 100% untouched -
 * the client's real WebSocket object never gets wrapped or stubbed.
 *
 * Semantics:
 *   - freeze(): every connection existing RIGHT NOW stops forwarding in BOTH directions;
 *     data arriving while frozen is DROPPED (not buffered - the point is loss, not delay).
 *     Dropping is chunk-atomic (whole TCP recv chunks), which for this app's small one-frame
 *     JSON messages means websocket framing stays intact across the freeze boundary.
 *   - NEW connections opened during a freeze forward normally - models the real resume shape
 *     where the OLD socket is a zombie but the network itself is fine, so a fresh reconnect
 *     succeeds immediately.
 *   - unfreeze(): frozen connections resume forwarding NEW data (everything dropped in
 *     between is gone for good, exactly like broadcasts delivered to a suspended webview).
 *
 * Used by test_freeze_recovery.js via the client's existing ?ws= URL override. Never anything
 * to do with production - it only ever points at a private local server instance.
 */
const net = require("net");

function createFreezeProxy({ listenPort, upstreamPort, upstreamHost = "127.0.0.1" }) {
  const pairs = new Set();
  let stats = { dropped: 0, connections: 0 };

  const server = net.createServer((client) => {
    const up = net.connect(upstreamPort, upstreamHost);
    const pair = { client, up, frozen: false };
    pairs.add(pair);
    stats.connections++;
    client.pause();
    up.on("connect", () => {
      client.resume();
      client.on("data", (buf) => {
        if (pair.frozen) { stats.dropped += buf.length; return; }
        up.write(buf);
      });
      up.on("data", (buf) => {
        if (pair.frozen) { stats.dropped += buf.length; return; }
        client.write(buf);
      });
    });
    const closeBoth = () => {
      pairs.delete(pair);
      try { client.destroy(); } catch (e) { /* ignore */ }
      try { up.destroy(); } catch (e) { /* ignore */ }
    };
    client.on("close", closeBoth); up.on("close", closeBoth);
    client.on("error", closeBoth); up.on("error", closeBoth);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(listenPort, "127.0.0.1", () => {
      resolve({
        port: listenPort,
        // Freeze every EXISTING connection; new ones keep working (see header).
        freeze() { for (const p of pairs) p.frozen = true; },
        unfreeze() { for (const p of pairs) p.frozen = false; },
        stats() { return { ...stats, live: pairs.size, frozen: [...pairs].filter((p) => p.frozen).length }; },
        close() {
          for (const p of [...pairs]) { try { p.client.destroy(); } catch (e) {} try { p.up.destroy(); } catch (e) {} }
          pairs.clear();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

module.exports = { createFreezeProxy };
