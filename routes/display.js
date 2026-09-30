'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../data/db');

router.get('/', (req, res) => res.redirect('/display/cashier'));

async function board(dept, res, next) {
  try {
    const [queue, windows, settings] = await Promise.all([
      db.getQueue(dept), db.getWindows(dept), db.getSettings(),
    ]);
    const announcement = await db.latestAnnouncement(dept);
    res.render('pages/display/board', {
      announcement,
      title: dept + ' Queue', dept, settings, windows,
      serving:  queue.filter(t => ['called','serving'].includes(t.ticketStatus)),
      priority: queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'priority').slice(0, 8),
      regular:  queue.filter(t => t.ticketStatus === 'waiting' && t.queueCategory === 'regular').slice(0, 8),
      recent:   queue.filter(t => t.ticketStatus === 'completed')
                     .sort((a,b) => new Date(b.completedAt) - new Date(a.completedAt)).slice(0, 6),
    });
  } catch (e) { next(e); }
}
router.get('/cashier',   (req, res, next) => board('Cashier', res, next));
router.get('/registrar', (req, res, next) => board('Registrar', res, next));

module.exports = router;
