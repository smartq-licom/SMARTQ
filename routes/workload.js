'use strict';
/**
 * Workload analytics page (data/workload.js), shared like Priority Requests:
 * the admin (/admin/workload, either office) and the Cashier and Registrar
 * staff (/staff/workload, locked to their own office).
 *
 * Query: office (admin only), day (the day for the window cards and the hour
 * by hour chart), from / to (the staff performance period; default this month).
 */
const express  = require('express');
const db       = require('../data/db');
const workload = require('../data/workload');

module.exports = function workloadRoutes(base, { lockedOffice = null } = {}) {
  const router = express.Router();
  const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  router.get('/', async (req, res, next) => {
    try {
      const office = lockedOffice ? lockedOffice(req) : (req.query.office === 'Registrar' ? 'Registrar' : 'Cashier');
      const t = db.today();
      const from = ok(req.query.from) ? req.query.from : t.slice(0, 8) + '01';
      const to   = ok(req.query.to) ? req.query.to : t;
      const settings = await db.getSettings();
      const w = await workload.page(office, { from, to, day: ok(req.query.day) ? req.query.day : null, settings });
      res.render('pages/shared/workload', { title: 'Workload', base, office, canPickOffice: !lockedOffice, w });
    } catch (e) { next(e); }
  });

  return router;
};
