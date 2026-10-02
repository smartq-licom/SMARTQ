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

  router.get('/proof/:id', async (req, res, next) => {
    try {
      const pr = await db.getPriorityRequest(req.params.id);
      if (!pr) return res.status(404).render('pages/error', { title: 'Not found', code: 404, message: 'File not found.' });
      res.type(pr.proofMime).sendFile(path.join(DIR, pr.proofFile));
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
      req.session.flash = approve
        ? `${pr.name} is now approved for the ${pr.categoryLabel} priority lane.`
        : `Request from ${pr.name} was rejected. They can upload new proof.`;
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
