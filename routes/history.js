'use strict';
/**
 * Queue History: every student/client with how many of their tickets were
 * completed, cancelled or are still pending, and each person's full ticket
 * history. Built from the transaction records. Shared by the admin
 * (/admin/history, all offices) and staff (/staff/history, own office only).
 */
const express = require('express');
const db      = require('../data/db');
const paging  = require('../data/paging');

module.exports = function historyRoutes(base, { officeOf = () => null } = {}) {
  const router = express.Router();

  async function choices(office) {
    return { ...(await db.getHistoryChoices(office)), statuses: Object.keys(db.HISTORY_STATUS) };
  }

  router.get('/', async (req, res, next) => {
    try {
      const office = officeOf(req.session.user);
      const f = db.historyFilters(req.query, office);
      const { rows, pg } = await db.getHistoryClients(f, paging.pageFrom(req.query));
      res.render('pages/shared/history', {
        title: 'Queue History', base, office, f, rows, pg, choices: await choices(office),
      });
    } catch (e) { next(e); }
  });

  router.get('/:userId', async (req, res, next) => {
    try {
      const office = officeOf(req.session.user);
      const f = db.historyFilters(req.query, office);
      const h = await db.getHistoryForClient(Number(req.params.userId), f, paging.pageFrom(req.query));
      if (!h || !['student', 'guest'].includes(h.user.role) && !h.rows.length) {
        req.session.error = 'That client was not found.';
        return res.redirect(base);
      }
      res.render('pages/shared/history-client', {
        title: h.user.fullName + ' — Transaction History', base, office, f, h, choices: await choices(office),
      });
    } catch (e) { next(e); }
  });

  return router;
};
