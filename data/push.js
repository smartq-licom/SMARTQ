'use strict';
/**
 * Phone notifications without SMS: Web Push.
 *
 * A student who taps "Turn on alerts" on their ticket gives the browser's push
 * address for that ticket. The server then sends short notices (called, leave
 * now, may not be served today, priority approved...) that arrive even when the
 * page is closed. Free; needs VAPID keys in the environment (see .env.example).
 * Without keys everything still works, only without these notices.
 */
const crypto  = require('crypto');
const webpush = require('web-push');
const pool    = require('../database/connection');

const q = async (sql, p = []) => (await pool.execute(sql, p))[0];

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const ENABLED = !!(PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (ENABLED) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://smartq-licom.onrender.com',
                          PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

/** Save (or refresh) one phone's subscription for one ticket. */
async function subscribe(txId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) return { error: 'Invalid subscription.' };
  const keys = sub.keys || {};
  if (!keys.p256dh || !keys.auth) return { error: 'Invalid subscription.' };
  const hash = crypto.createHash('sha256').update(sub.endpoint).digest('hex');
  await q(
    `INSERT INTO push_subscriptions (transaction_id,endpoint_hash,endpoint,p256dh,auth) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE p256dh=VALUES(p256dh), auth=VALUES(auth)`,
    [txId, hash, sub.endpoint.slice(0, 2000), String(keys.p256dh).slice(0, 255), String(keys.auth).slice(0, 255)]);
  return { ok: true };
}

/**
 * Notify every phone subscribed to a ticket. Never throws: a notice that
 * cannot be delivered must not break calling a number or saving a decision.
 * Subscriptions the push service says are gone (404/410) are removed.
 */
async function sendToTicket(txId, { title, body, url }) {
  if (!ENABLED || !txId) return 0;
  let sent = 0;
  try {
    const subs = await q('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE transaction_id=?', [txId]);
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title, body, url: url || '/queue', tag: 'smartq-' + txId }),
          { TTL: 60 * 30, urgency: 'high' });
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) await q('DELETE FROM push_subscriptions WHERE id=?', [s.id]);
        else console.error('[PUSH]', e.statusCode || e.message);
      }
    }
  } catch (e) { console.error('[PUSH]', e.message); }
  return sent;
}

module.exports = { ENABLED, PUBLIC_KEY, subscribe, sendToTicket };
