'use strict';
/**
 * Real-time "something changed" pings (Server-Sent Events).
 *
 * Every open board, ticket and staff screen keeps one light connection to
 * GET /live/events. Whenever the line changes (a ticket joins, is called,
 * paid, cancelled, moved to priority, a window opens or closes...) the server
 * sends one ping to all of them, and each page fetches its own fresh parts
 * (partials/live). No data travels in the ping, so it can be public.
 *
 * changed() is called after any request that changes something and by the
 * background jobs; pings are merged (CHANGE_MERGE_MS) so a burst of changes
 * costs one refresh.
 */
const clients = new Set();
const CHANGE_MERGE_MS = 250;
const HEARTBEAT_MS = 25000;        // keeps proxies (Render) from closing an idle stream
let timer = null;

function changed() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    for (const res of clients) { try { res.write('data: changed\n\n'); } catch (e) { clients.delete(res); } }
  }, CHANGE_MERGE_MS);
}

function stream(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');                    // reconnect after 5 s if the stream drops
  clients.add(res);
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* closed */ } }, HEARTBEAT_MS);
  req.on('close', () => { clearInterval(beat); clients.delete(res); });
}

// POSTs that only look something up: no ping
const READ_ONLY = /^\/(login|logout|queue\/(priority-known|claimables|find|track)|queue\/t\/[a-f0-9]{32}\/push)\b/;

/** Express middleware: ping after any successful change. */
function afterChanges(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !READ_ONLY.test(req.path)) {
    res.on('finish', () => { if (res.statusCode < 400) changed(); });
  }
  next();
}

module.exports = { changed, stream, afterChanges, clientCount: () => clients.size };
