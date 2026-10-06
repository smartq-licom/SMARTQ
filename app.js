'use strict';
require('dotenv').config();
// Philippine time before anything creates a Date (see database/connection.js).
process.env.TZ = process.env.APP_TZ || 'Asia/Manila';
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path    = require('path');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');
const db      = require('./data/db');

const app  = express();
// Render (and most hosts) say which port to use through PORT.
const PORT = process.env.PORT || process.env.APP_PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

if (PROD && !process.env.SESSION_SECRET) {
  console.error('  SESSION_SECRET must be set in production. Refusing to start.');
  process.exit(1);
}

// Behind Render's HTTPS proxy: trust it so secure cookies are sent and
// req.ip is the visitor's address (the login rate limit depends on it).
if (PROD) app.set('trust proxy', 1);

// ── Middleware ───────────────────────────────────────────────────────────────
// The boards and ticket pages poll /pulse every ~1.5 s; keep that out of the log.
app.use(morgan('dev', { skip: req => req.path.endsWith('/pulse') }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  name: 'smartq.sid',
  // Kept in MySQL so logins survive restarts, deploys and Render's idle sleep.
  store: new MySQLStore({ clearExpired: true }, require('./database/connection')),
  secret: process.env.SESSION_SECRET || 'smartq-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,                                   // not readable by scripts
    sameSite: 'lax',                                  // basic CSRF protection
    secure: process.env.NODE_ENV === 'production',    // HTTPS only in production
    maxAge: 1000 * 60 * 60 * 8,
  },
}));

// Slow down brute-force attempts on the authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts from this device. Please wait a few minutes and try again.',
});
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many verification attempts. Please wait a few minutes and try again.',
});
// only the sign-in itself counts, not opening the page
app.use('/login', (req, res, next) => (req.method === 'POST' ? authLimiter(req, res, next) : next()));
app.use('/forgot-password', authLimiter);
app.use('/verify',          otpLimiter);
// Students queue without an account. Booking codes are short, so guessing is
// slowed down; getting a number allows more, because a whole campus can share
// one Wi-Fi address.
const findLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: 'Too many tries from this network. Please wait a few minutes, or ask at the office window.' });
app.use('/queue/find', (req, res, next) => (req.method === 'POST' ? findLimiter(req, res, next) : next()));
const newTicketLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  message: 'Too many requests from this network. Please wait a few minutes and try again.' });
app.use('/queue/new', (req, res, next) => (req.method === 'POST' ? newTicketLimiter(req, res, next) : next()));

// current user + flash available to every view
app.use((req, res, next) => {
  res.locals.me    = req.session.user || null;
  res.locals.perms = req.session.perms || [];
  res.locals.flash = req.session.flash || null;
  res.locals.error = req.session.error || null;
  // for pagers: links keep the current search/filters and change only ?page=
  res.locals.query    = req.query;
  res.locals.pagePath = req.originalUrl.split('?')[0];
  delete req.session.flash;
  delete req.session.error;
  next();
});

// Red dot on "Priority Requests": how many proofs wait for review. Only for
// the people who review them, and only for pages (not the background checks).
app.use(async (req, res, next) => {
  res.locals.priorityPending = null;
  const u = req.session.user;
  if (!u || !['admin', 'cashier', 'registrar'].includes(u.role) || req.method !== 'GET'
      || /\/(pulse|count)$/.test(req.path)) return next();
  try { res.locals.priorityPending = await db.countPendingPriority(); } catch (e) { /* the dot is optional */ }
  next();
});

// A staff member whose password the admin reset must choose a new one before
// using anything else (only My Account and logging out stay open).
app.use((req, res, next) => {
  const u = req.session.user;
  if (u && u.mustChangePassword && ['cashier', 'registrar'].includes(u.role)
      && !req.path.startsWith('/staff/account') && req.path !== '/logout') {
    if (req.method === 'GET') {
      req.session.error = 'Your password was reset. Please choose a new password to continue.';
      return res.redirect('/staff/account');
    }
    return res.status(403).send('Change your password first.');
  }
  next();
});

// ── Auth guards ──────────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    if (!roles.includes(u.role)) {
      return res.status(403).render('pages/error', {
        title: 'Not allowed', code: 403,
        message: 'Your account does not have access to that page.',
      });
    }
    next();
  };
}
app.locals.requireLogin = requireLogin;
module.exports.requireRole = requireRole;

// ── View engine ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Shared UI helpers (on app.locals so partials can use them too) ───────────
app.locals.UI = {
  card:    'bg-white rounded-xl border border-hair shadow-sm overflow-hidden',
  cardHd:  'px-5 py-3.5 border-b border-hair flex items-center justify-between gap-3',
  cardTtl: 'text-[13.5px] font-bold text-ink',
  body:    'p-5',
  btn:     'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
  btnMain: 'bg-brand text-white hover:bg-brand-deep',
  btnOk:   'bg-brand text-white hover:bg-brand-deep',
  btnGh:   'bg-mist text-ink border border-hair hover:bg-hair',
  btnBad:  'bg-red-700 text-white hover:bg-red-800',
  btnSm:   'px-3 py-1.5 text-[12px]',
  input:   'w-full rounded-lg border border-hair px-3 py-2.5 text-[13.5px] text-ink bg-white focus:border-brand focus:ring-1 focus:ring-brand outline-none',
  lbl:     'block text-[12.5px] font-semibold text-slateSoft mb-1.5',
  hint:    'block text-[11.5px] text-slateSoft/70 mt-1',
  th:      'px-3.5 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-slateSoft/80 bg-mist whitespace-nowrap',
  td:      'px-3.5 py-2.5 text-[13px] text-ink align-middle',
  tr:      'border-b border-hair/70 last:border-0 hover:bg-brand-wash/40',
};
app.locals.pill = 'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold';
app.locals.tone = s => ({
  waiting:'bg-amber-100 text-amber-800', called:'bg-brand-wash text-brand-deep',
  serving:'bg-brand-wash text-brand-deep', completed:'bg-emerald-100 text-emerald-800',
  cancelled:'bg-red-100 text-red-800', 'no-show':'bg-red-100 text-red-800',
  paid:'bg-emerald-100 text-emerald-800', pending:'bg-amber-100 text-amber-800',
  not_required:'bg-mist text-slateSoft',
  priority:'bg-violet-100 text-violet-800', regular:'bg-mist text-slateSoft',
  pwd:'bg-brand-wash text-brand-deep', senior:'bg-violet-100 text-violet-800',
  pregnant:'bg-pink-100 text-pink-800',
  open:'bg-emerald-100 text-emerald-800', closed:'bg-red-100 text-red-800',
  break:'bg-amber-100 text-amber-800',
  student:'bg-mist text-slateSoft', guest:'bg-violet-100 text-violet-800',
  normal:'bg-emerald-100 text-emerald-800', busy:'bg-amber-100 text-amber-800',
  full:'bg-red-100 text-red-800',
  // peak-hour levels
  peak:'bg-red-100 text-red-800', moderate:'bg-brand-wash text-brand-deep',
  quiet:'bg-emerald-100 text-emerald-800',
  payment_completed:'bg-emerald-100 text-emerald-800',
  waiting_registrar:'bg-amber-100 text-amber-800',
  cashier_processing:'bg-brand-wash text-brand-deep',
  registrar_processing:'bg-brand-wash text-brand-deep',
  admin:'bg-ink text-white', cashier:'bg-brand text-white', registrar:'bg-brand text-white',
}[s] || 'bg-mist text-slateSoft');
app.locals.peso  = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
app.locals.chip  = 'font-mono font-bold text-[12.5px] bg-brand-wash border border-brand-line rounded px-2 py-0.5 text-brand-deep';
app.locals.label = s => String(s || '').replace(/_/g, ' ');
// 472 -> "about 7 hours and 52 minutes"; 25 -> "about 25 minutes".
// short: "~7 h 52 min" (small labels).
app.locals.duration = (m, short) => {
  if (m == null) return null;
  m = Math.max(0, Math.round(m));
  if (m < 1) return short ? 'under a minute' : 'less than a minute';
  const h = Math.floor(m / 60), r = m % 60;
  if (short) return '~' + (h ? h + ' h' + (r ? ' ' + r + ' min' : '') : r + ' min');
  const hs = h ? h + (h === 1 ? ' hour' : ' hours') : '';
  const rs = r ? r + (r === 1 ? ' minute' : ' minutes') : '';
  return 'about ' + (hs && rs ? hs + ' and ' + rs : hs || rs);
};

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/',        require('./routes/auth'));
// Students no longer log in: the QR code opens /queue (routes/queue.js).
app.use('/queue',   require('./routes/queue'));
app.use('/student', (req, res) => res.redirect('/queue'));
app.use('/staff',   requireLogin, requireRole('cashier','registrar'), require('./routes/staff'));
app.use('/admin',   requireLogin, requireRole('admin'), require('./routes/admin'));
app.use('/display', require('./routes/display'));

// ── Auto-cancel job (never touches a paid transaction) ───────────────────────
setInterval(async () => {
  try { await db.processAutoCancel(); }
  catch (e) { console.error('[AUTO-CANCEL]', e.message); }
}, 15 * 1000);

// ── Decision engine watcher (data/engine.js) ─────────────────────────────────
// Re-runs the day simulation and sends phone alerts: "leave now" 15 minutes
// before a turn, and "you may not be served today". One run at a time.
const engine = require('./data/engine');
let watching = false;
setInterval(async () => {
  if (watching) return;
  watching = true;
  try { await engine.watch(); }
  catch (e) { console.error('[ENGINE]', e.message); }
  finally { watching = false; }
}, 30 * 1000);

// ── Errors ───────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).render('pages/error', {
  title: 'Page not found', code: 404,
  message: 'The page you are looking for does not exist.',
}));
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message);
  res.status(500).render('pages/error', {
    title: 'Server error', code: 500,
    message: err.message || 'Something went wrong on our side.',
  });
});

// ── Start server (listens on all interfaces so phones on the same Wi-Fi can reach it)
const os = require('os');
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  SmartQ v5 is running`);
  console.log(`  On this computer : http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  On your phone    : http://${net.address}:${PORT}   (${name})`);
      }
    }
  }
  console.log('');
});
