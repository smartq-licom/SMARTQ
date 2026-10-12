'use strict';
/**
 * Time saved: SmartQ against the office's current (manual) process.
 *
 * The current process is a baseline the admin types in once (Settings), from
 * the time-and-motion study or survey:
 *   formTrip       minutes to get the request form at the Registrar first
 *   cashierLine    minutes standing in the Cashier line
 *   registrarLine  minutes standing in the Registrar line
 *   returnTrip     minutes of a wasted trip (document not ready yet)
 *   returnRate     % of claims that needed such a trip
 *
 * SmartQ is measured, per completed ticket in the report's filters:
 *   in-office wait = the wait, but at most IN_OFFICE minutes: the client waits
 *                    wherever they like and comes when the phone says "Leave
 *                    now" (15 minutes before the turn)
 *   form trip      = none (the request is made online)
 *   return trips   = none counted (the ready date is known and the claim is
 *                    booked on or after it)
 * Service time at the window is the same either way, so it is left out.
 *
 * Smart order vs plain first come, first served: every real day in the period
 * is replayed twice with its real arrivals, real service minutes and the
 * number of windows that day: once in plain FCFS order, once with the Smart
 * Priority Score (data/dispatch.js). The difference in average wait is what
 * the ordering alone saved.
 */
const pool     = require('../database/connection');
const dispatch = require('./dispatch');
const q = async (sql, p = []) => (await pool.query(sql, p))[0];

const IN_OFFICE = 15;     // "Leave now" comes 15 minutes before the turn
const FIELDS = {
  formTrip:      'Get the request form at the Registrar first',
  cashierLine:   'Stand in the Cashier line',
  registrarLine: 'Stand in the Registrar line',
  returnTrip:    'A wasted trip (document not ready yet)',
  returnRate:    'Claims that needed a wasted trip (%)',
};

/** The baseline from settings (JSON text), every field a number >= 0. */
function readBaseline(raw) {
  let b = {};
  try { b = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch (e) { b = {}; }
  const out = {};
  for (const k of Object.keys(FIELDS)) {
    const v = Number(b[k]);
    out[k] = Number.isFinite(v) && v >= 0 ? Math.min(k === 'returnRate' ? 100 : 600, v) : 0;
  }
  out.isSet = out.cashierLine > 0 || out.registrarLine > 0 || out.formTrip > 0;
  return out;
}

/** Replays one office's day: plain FCFS against the Smart Priority Score. Average wait each way. */
function replayDay(clients, windows) {
  const run = smart => {
    const lanes = { priority: [], regular: [] };
    const pending = clients.map(c => ({ ...c, skip: 0 })).sort((a, b) => a.queuedAt - b.queuedAt);
    const free = Array.from({ length: Math.max(1, windows) }, () => pending.length ? pending[0].queuedAt : 0);
    let lastCat = 'regular', total = 0, n = 0, i = 0;
    while (i < pending.length || lanes.priority.length || lanes.regular.length) {
      const w = free.indexOf(Math.min(...free));
      let t = free[w];
      if (!lanes.priority.length && !lanes.regular.length && i < pending.length) t = Math.max(t, pending[i].queuedAt);
      while (i < pending.length && pending[i].queuedAt <= t) { const c = pending[i++]; lanes[c.lane].push(c); }
      if (!lanes.priority.length && !lanes.regular.length) { free[w] = t; continue; }
      const lane = lanes.priority.length && lanes.regular.length ? (lastCat === 'priority' ? 'regular' : 'priority')
                 : (lanes.priority.length ? 'priority' : 'regular');
      const list = lanes[lane];
      let pick = list[0];
      if (smart) {
        const peak = lanes.priority.length + lanes.regular.length >= dispatch.PEAK_PER_WINDOW * free.length;
        pick = dispatch.rankLane(list, { now: t, peak })[0];
        list.slice(0, list.indexOf(pick)).forEach(x => { x.skip++; });
      }
      list.splice(list.indexOf(pick), 1);
      total += (t - pick.queuedAt) / 60000; n++;
      free[w] = t + pick.svc * 60000;
      lastCat = lane;
    }
    return n ? total / n : 0;
  };
  return { fcfs: run(false), smart: run(true) };
}

/**
 * The report: one row per office, and the totals. `where`/`p` are the report
 * builder's filters (dates, office...); only completed tickets count.
 */
async function timeSavedReport(where, p, baselineRaw) {
  const base = readBaseline(baselineRaw);
  const w = `${where ? where + ' AND' : 'WHERE'} t.ticket_status='completed' AND t.called_at IS NOT NULL`;
  const rows = await q(
    `SELECT t.id, t.department, t.service_date, t.queue_category, t.window_id,
            COALESCE(t.queue_at, t.requested_at) AS queued, t.called_at, t.actual_minutes,
            EXISTS (SELECT 1 FROM transaction_documents td JOIN documents d ON d.id = td.document_id
                    WHERE td.transaction_id = t.id AND d.requires_claim = 1) AS needs_form,
            EXISTS (SELECT 1 FROM claim_items ci WHERE ci.claim_tx_id = t.id) AS is_claim
     FROM transactions t ${w} ORDER BY t.service_date, t.department, queued`, p);

  const by = {};
  for (const r of rows) {
    const o = by[r.department] = by[r.department] || { department: r.department, clients: 0, waitSum: 0, inOfficeSum: 0, oldSum: 0, days: {} };
    const wait = Math.max(0, (new Date(r.called_at) - new Date(r.queued)) / 60000);
    const old = (r.department === 'Cashier' ? base.cashierLine : base.registrarLine)
              + (r.department === 'Cashier' && r.needs_form ? base.formTrip : 0)
              + (r.is_claim ? base.returnTrip * base.returnRate / 100 : 0);
    o.clients++; o.waitSum += wait; o.inOfficeSum += Math.min(wait, IN_OFFICE); o.oldSum += old;
    // for the replay: that day's real arrivals and service times
    const day = String(r.service_date instanceof Date ? r.service_date.toISOString() : r.service_date).slice(0, 10);
    const d = o.days[day] = o.days[day] || { clients: [], windows: new Set() };
    d.clients.push({ id: r.id, queuedAt: new Date(r.queued).getTime(), readyAt: new Date(r.queued).getTime(),
                     svc: Math.max(1, Number(r.actual_minutes) || 1), lane: r.queue_category === 'priority' ? 'priority' : 'regular' });
    if (r.window_id) d.windows.add(r.window_id);
  }

  const list = Object.values(by).map(o => {
    let fcfs = 0, smart = 0, replayed = 0;
    for (const d of Object.values(o.days)) {
      const x = replayDay(d.clients, d.windows.size || 1);
      fcfs += x.fcfs * d.clients.length; smart += x.smart * d.clients.length; replayed += d.clients.length;
    }
    const oldPer = o.clients ? o.oldSum / o.clients : 0;
    const newPer = o.clients ? o.inOfficeSum / o.clients : 0;
    const savedPer = base.isSet ? Math.max(0, oldPer - newPer) : null;
    return {
      department: o.department, clients: o.clients,
      avgWait: o.clients ? o.waitSum / o.clients : 0,     // the whole wait, wherever they spent it
      oldPer, newPer, savedPer,
      savedHours: savedPer === null ? null : savedPer * o.clients / 60,
      pct: savedPer === null || !oldPer ? null : Math.round(savedPer / oldPer * 100),
      orderSaved: replayed ? Math.max(0, (fcfs - smart) / replayed) : 0,
      fcfsWait: replayed ? fcfs / replayed : 0, smartWait: replayed ? smart / replayed : 0,
      days: Object.keys(o.days).length,
    };
  });
  const clients = list.reduce((s, r) => s + r.clients, 0);
  const sum = k => list.reduce((s, r) => s + (r[k] || 0) * r.clients, 0);
  const totals = {
    clients,
    oldPer: clients ? sum('oldPer') / clients : 0,
    newPer: clients ? sum('newPer') / clients : 0,
    savedPer: base.isSet && clients ? sum('savedPer') / clients : null,
    savedHours: base.isSet ? list.reduce((s, r) => s + (r.savedHours || 0), 0) : null,
    orderSaved: clients ? sum('orderSaved') / clients : 0,
  };
  totals.pct = totals.savedPer !== null && totals.oldPer ? Math.round(totals.savedPer / totals.oldPer * 100) : null;
  return { rows: list, totals, baseline: base, inOffice: IN_OFFICE };
}

module.exports = { FIELDS, IN_OFFICE, readBaseline, replayDay, timeSavedReport };
