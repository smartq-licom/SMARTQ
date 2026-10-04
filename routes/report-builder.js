'use strict';
/**
 * Report builder shared by the admin (/admin/reports, every office) and staff
 * (/staff/reports, their own office). Nothing is read until the user presses
 * Generate Report; then only the records matching the chosen report type and
 * filters are read, filtered in SQL, one page at a time. The same filters
 * drive the print view (all matching rows) and the CSV download.
 *
 * Query parameters: rtype, rfrom, rto, q, document, status, staff, lane,
 * office (admin only), generate=1, page.
 */
const db     = require('../data/db');
const paging = require('../data/paging');

function today() { return db.today(); }

/** The builder's filters from the query string (dates default to this month). */
function readFilters(query, office) {
  const t = today();
  const f = db.historyFilters({
    q: query.q, document: query.document, status: query.status, staff: query.staff,
    lane: query.lane, office: query.office,
    from: query.rfrom || t.slice(0, 8) + '01', to: query.rto || t,
  }, office);
  const type = db.REPORT_TYPES[query.rtype] ? query.rtype : 'transactions';
  return { type, f };
}

/** Plain-language list of what the report was filtered on. */
function criteria(type, f, choices) {
  const fmt = s => new Date(s + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  const doc = choices.documents.find(d => d.id === f.documentId);
  const st = choices.staff.find(s => s.id === f.staffId);
  const statusLabel = { completed: 'Completed / served', cancelled: 'Cancelled', 'no-show': 'No-show', pending: 'Pending' };
  return [
    ['Report type', db.REPORT_TYPES[type]],
    ['Date range', (f.from ? fmt(f.from) : 'the beginning') + ' – ' + (f.to ? fmt(f.to) : 'today')],
    ['Office', f.office || 'Both offices'],
    ['Transaction type', doc ? doc.name : 'All transactions'],
    ['Status', f.status ? statusLabel[f.status] : 'Any status'],
    ['Queue type', f.lane ? f.lane[0].toUpperCase() + f.lane.slice(1) : 'Regular and priority'],
    ['Staff', st ? st.name : 'All staff'],
    ['Student / client', f.q || 'All students and clients'],
  ];
}

/** Everything the builder card needs; runs the report only when asked. */
async function build(query, office) {
  const { type, f } = readFilters(query, office);
  const choices = { ...(await db.getHistoryChoices(office)), statuses: Object.keys(db.HISTORY_STATUS) };
  const generated = query.generate === '1';
  const result = generated ? await db.runReport(type, f, { page: paging.pageFrom(query) }) : null;
  return { reportTypes: db.REPORT_TYPES, rtype: type, rf: f, choices, generated, result,
           criteria: criteria(type, f, choices), reportOffice: office };
}

/** All matching rows, for the print view. */
async function buildAll(query, office) {
  const b = await build({ ...query, generate: '0' }, office);
  b.result = await db.runReport(b.rtype, b.rf, { all: true });
  b.generated = true;
  return b;
}

// ---- CSV ---------------------------------------------------------------------
const cell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const when = d => d ? new Date(d).toLocaleString('en-PH', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

function toCsv(r) {
  let head, lines;
  if (r.type === 'transactions') {
    head = ['Queue No.', 'Date', 'Requested', 'Office', 'Lane', 'Client', 'Student No.', 'Transaction',
            'Staff', 'Window', 'Status', 'Amount', 'Receipt', 'Completed'];
    lines = r.rows.map(t => [t.ticketNo, t.serviceDate, when(t.requestedAt), t.department, t.queueCategory,
      t.fullName, t.studentNo, t.documents.map(d => d.label).join('; '), t.staffName, t.windowLabel,
      t.ticketStatus, t.amountDue.toFixed(2), t.receiptNo || '', t.ticketStatus === 'completed' ? when(t.completedAt) : '']);
  } else if (r.type === 'payments') {
    head = ['Receipt No.', 'Paid', 'Queue No.', 'Client', 'Student No.', 'Transaction', 'Cashier', 'Window', 'Amount'];
    lines = r.rows.map(x => [x.receiptNo, when(x.paidAt), x.ticketNo, x.client, x.studentNo, x.documents,
      x.cashier, x.window, x.amount.toFixed(2)]);
    lines.push(['', '', '', '', '', '', '', 'Total', r.totals.amount.toFixed(2)]);
  } else if (r.type === 'documents') {
    head = ['Document', 'Office', 'Requests', 'Copies', 'Completed', 'Cancelled / No-show', 'Collected'];
    lines = r.rows.map(x => [x.name, x.department, x.requests, x.copies, x.completed, x.cancelled, x.collected.toFixed(2)]);
  } else {
    head = ['Staff', 'Office', 'Handled', 'Completed', 'Cancelled / No-show', 'Avg service (min)', 'Collected'];
    lines = r.rows.map(x => [x.name, x.department, x.handled, x.completed, x.cancelled, x.avgMin === null ? '' : x.avgMin, x.collected.toFixed(2)]);
  }
  // BOM so Excel opens the peso sign and names with ñ correctly
  return '﻿' + [head, ...lines].map(row => row.map(cell).join(',')).join('\r\n');
}

async function sendCsv(query, office, res) {
  const { rtype, rf } = await build({ ...query, generate: '0' }, office);
  const r = await db.runReport(rtype, rf, { all: true });
  const name = `smartq-${rtype}-${rf.from || 'start'}-to-${rf.to || today()}${office ? '-' + office.toLowerCase() : ''}.csv`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send(toCsv(r));
}

module.exports = { build, buildAll, sendCsv };
