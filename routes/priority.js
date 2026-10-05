'use strict';
/**
 * Priority-lane requests (PWD / Senior / Pregnant): review the uploaded proof,
 * approve or reject. Shared by the admin (/admin/priority) and the Cashier and
 * Registrar staff (/staff/priority). Removing an approved status is admin-only.
 */
const express = require('express');
const path    = require('path');
const db      = require('../data/db');
const mailer  = require('../data/mailer');
const { DIR } = require('../data/uploads');

module.exports = function priorityRoutes(base, { canRevoke = false } = {}) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const all = await db.getPriorityRequests();
      res.render('pages/admin/priority', {
        title: 'Priority Requests', all, base, canRevoke,
        pending:  all.filter(r => r.status === 'pending'),
        reviewed: all.filter(r => r.status !== 'pending'),
        labels: db.PRIORITY_LABELS,
      });
    } catch (e) { next(e); }
  });

  // How many are waiting: the red dot on the menu checks this every few seconds.
  router.get('/count', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ pending: await db.countPendingPriority() });
    } catch (e) { next(e); }
  });

  router.get('/proof/:id', async (req, res, next) => {
    try {
      const pr = await db.getPriorityProof(req.params.id);
      if (!pr || (!pr.data && !pr.file))
        return res.status(404).render('pages/error', { title: 'Not found', code: 404, message: 'File not found.' });
      res.set('Cache-Control', 'private, no-store');
      if (pr.data) return res.type(pr.mime).send(pr.data);     // walk-in proof, kept in the database
      res.type(pr.mime).sendFile(path.join(DIR, pr.file));
    } catch (e) { next(e); }
  });

  router.post('/:id/decide', async (req, res, next) => {
    try {
      const approve = req.body.decision === 'approve';
      const r = await db.decidePriorityRequest(req.session.user, req.params.id, approve, req.body.reason);
      if (r.error) { req.session.error = r.error; return res.redirect(base); }
      const pr = r.request;
      if (pr.email) {
        try { await mailer.sendPriorityDecision(pr.email, pr.name, pr.category, approve, pr.reason); }
        catch (e) { console.error('[MAIL]', e.message); }
      }
      req.session.flash = !approve
        ? `Request from ${pr.name} was rejected. Their ticket stays in the regular line.`
        : r.moved
          ? `${pr.name} approved: ${r.moved.from} is now ${r.moved.to} in the priority lane.`
          : `${pr.name} is now approved for the ${pr.categoryLabel} priority lane.`;
      res.redirect(base);
    } catch (e) { next(e); }
  });

  if (canRevoke) {
    router.post('/revoke/:userId', async (req, res, next) => {
      try {
        await db.revokePriority(req.params.userId);
        req.session.flash = 'Priority status removed.';
        res.redirect(base);
      } catch (e) { next(e); }
    });
  }

  return router;
};
