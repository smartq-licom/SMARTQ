'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../data/db');
const auth    = require('../data/auth');
const mailer  = require('../data/mailer');
const { passport: gpassport, ENABLED: GOOGLE_ON } = require('../data/google');

function home(role) {
  if (role === 'admin') return '/admin/dashboard';
  if (role === 'cashier' || role === 'registrar') return '/staff/dashboard';
  return '/student/dashboard';
}

/** Only follow ?next= to a page on this site, never to another domain. */
const safeNext = n => (typeof n === 'string' && /^\/(?![\/\\])/.test(n) ? n : '');

/**
 * Create the real session, after the password, Google or an OTP has checked out.
 * The session id is regenerated so a pre-login id cannot be replayed.
 */
function startSession(req, user, perms) {
  return new Promise((resolve, reject) => {
    const flash = req.session.flash;
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.user  = user;
      req.session.perms = perms;
      if (flash) req.session.flash = flash;
      resolve(db.needsProfile(user) ? '/complete-profile' : home(user.role));
    });
  });
}

/** Park the half-authenticated user until they pass the OTP step. */
function setPending(req, user, purpose, extra) {
  req.session.pending = Object.assign({
    userId: user.id, email: user.email, masked: auth.maskEmail(user.email),
    name: user.firstName, purpose,
  }, extra || {});
}

async function sendCode(user, purpose, opts) {
  opts = opts || {};
  const otp = await auth.issueOtp(user.id, opts.toEmail || user.email, purpose, opts);
  if (otp.error) return otp;
  try {
    await mailer.sendOtp(otp.email, user.firstName, otp.code, purpose, otp.minutes);
  } catch (e) {
    console.error('[MAIL] delivery failed');   // never log the code itself
    return { error: 'We could not send the verification email. Please try again shortly.' };
  }
  return otp;
}

// ── LOGIN ────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  if (req.session.user) return res.redirect(home(req.session.user.role));
  res.render('pages/auth/login', { title: 'Log In', next: req.query.next || '' });
});

router.post('/login', async (req, res, next) => {
  try {
    const identifier = req.body.identifier, password = req.body.password;
    if (!identifier || !password) {
      req.session.error = 'Please enter your username or Gmail and your password.';
      return res.redirect('/');
    }
    const result = await db.verifyCredentials(identifier, password);
    if (result.error) { req.session.error = result.error; return res.redirect('/'); }

    if (result.pending) {
      setPending(req, result.user, 'registration');
      await sendCode(result.user, 'registration', { force: true });
      req.session.error = 'Your account has not been verified. We sent a new code to your email.';
      return res.redirect('/verify');
    }

    // The email was proven with a code at registration, so a verified account
    // with the right password signs straight in.
    const user = result.user;
    await auth.clearFailedLogins(user.id);
    const to = await startSession(req, user, await db.getPermissions(user.role));
    res.redirect(safeNext(req.body.next) || to);
  } catch (e) { next(e); }
});

// ── REGISTER ─────────────────────────────────────────────────────────────────
router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect(home(req.session.user.role));
  res.render('pages/auth/register', {
    title: 'Create Account', form: {}, formError: null, rules: auth.PASSWORD_RULES,
  });
});

router.post('/register', async (req, res, next) => {
  try {
    const result = await db.registerLocal(req.body);
    if (result.error) {
      return res.status(400).render('pages/auth/register', {
        title: 'Create Account', form: req.body, formError: result.error, rules: auth.PASSWORD_RULES,
      });
    }
    setPending(req, result.user, 'registration');
    await sendCode(result.user, 'registration', { force: true });
    req.session.flash = 'Account created. Enter the code we sent to your email to activate it.';
    res.redirect('/verify');
  } catch (e) { next(e); }
});

// ── OTP SCREEN ───────────────────────────────────────────────────────────────
router.get('/verify', async (req, res, next) => {
  try {
    const p = req.session.pending;
    if (!p) return res.redirect('/');
    res.render('pages/auth/verify', {
      title: 'Verify your email', pending: p,
      secondsLeft: await auth.otpSecondsLeft(p.userId, p.purpose),
      cooldown: await auth.cooldownLeft(p.userId, p.purpose),
      devMode: !mailer.HAS_SMTP,
    });
  } catch (e) { next(e); }
});

router.post('/verify', async (req, res, next) => {
  try {
    const p = req.session.pending;
    if (!p) return res.redirect('/');

    const check = await auth.verifyOtp(p.userId, p.purpose, req.body.code);
    if (check.error) { req.session.error = check.error; return res.redirect('/verify'); }

    if (p.purpose === 'password_reset' || p.purpose === 'account_recovery') {
      req.session.resetFor = { userId: p.userId, purpose: p.purpose };
      delete req.session.pending;
      return res.redirect('/reset-password');
    }

    if (p.purpose === 'email_change') {
      const out = await db.updateEmail(p.userId, check.payload);
      delete req.session.pending;
      if (out.error) { req.session.error = out.error; return res.redirect('/student/account'); }
      req.session.user = await db.getUser(p.userId);
      req.session.flash = 'Your email address has been updated.';
      return res.redirect('/student/account');
    }

    if (p.purpose === 'registration') await db.activateAccount(p.userId);

    const user = await db.getUser(p.userId);
    await auth.clearFailedLogins(user.id);
    const nextUrl = p.next;
    delete req.session.pending;
    req.session.flash = 'Signed in.';
    const to = await startSession(req, user, await db.getPermissions(user.role));
    res.redirect(safeNext(nextUrl) || to);
  } catch (e) { next(e); }
});

router.post('/verify/resend', async (req, res, next) => {
  try {
    const p = req.session.pending;
    if (!p) return res.redirect('/');
    const user = await db.getUser(p.userId);
    const otp  = await sendCode(user, p.purpose, { toEmail: p.toEmail || user.email });
    if (otp.error) req.session.error = otp.error;
    else req.session.flash = 'A new code is on its way.';
    res.redirect('/verify');
  } catch (e) { next(e); }
});

router.get('/verify/cancel', (req, res) => {
  delete req.session.pending;
  res.redirect('/');
});

// ── FORGOT PASSWORD / ACCOUNT RECOVERY ───────────────────────────────────────
router.get('/forgot-password', (req, res) =>
  res.render('pages/auth/forgot-password', { title: 'Forgot Password', mode: 'password_reset' }));

router.get('/recover', (req, res) =>
  res.render('pages/auth/forgot-password', { title: 'Account Recovery', mode: 'account_recovery' }));

router.post('/forgot-password', async (req, res, next) => {
  try {
    const purpose = req.body.mode === 'account_recovery' ? 'account_recovery' : 'password_reset';
    const back    = purpose === 'account_recovery' ? '/recover' : '/forgot-password';
    const user    = await db.findByEmail(req.body.email);

    // Same answer either way, so the form cannot be used to discover accounts.
    const generic = 'If an account is associated with that email address, we have sent recovery instructions.';

    if (!user || user.status === 'disabled') {
      req.session.flash = generic;
      return res.redirect(back);
    }
    setPending(req, user, purpose);
    const otp = await sendCode(user, purpose, { force: true });
    if (otp.error) { req.session.error = otp.error; return res.redirect(back); }
    req.session.flash = generic;
    res.redirect('/verify');
  } catch (e) { next(e); }
});

// ── RESET PASSWORD ───────────────────────────────────────────────────────────
router.get('/reset-password', (req, res) => {
  if (!req.session.resetFor) return res.redirect('/');
  res.render('pages/auth/reset-password', {
    title: 'Reset Password', rules: auth.PASSWORD_RULES, formError: null,
  });
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const r = req.session.resetFor;
    if (!r) return res.redirect('/');
    if (req.body.newPassword !== req.body.confirmPassword) {
      return res.status(400).render('pages/auth/reset-password', {
        title: 'Reset Password', rules: auth.PASSWORD_RULES, formError: 'Passwords do not match.',
      });
    }
    const out = await db.setPassword(r.userId, req.body.newPassword);
    if (out.error) {
      return res.status(400).render('pages/auth/reset-password', {
        title: 'Reset Password', rules: auth.PASSWORD_RULES, formError: out.error,
      });
    }
    delete req.session.resetFor;
    req.session.flash = 'Your password has been successfully updated. Please log in.';
    res.redirect('/');
  } catch (e) { next(e); }
});

// ── GOOGLE ───────────────────────────────────────────────────────────────────
router.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_ON) {
    req.session.error = 'Google sign-in is not configured on this server yet.';
    return res.redirect('/');
  }
  gpassport.authenticate('google', {
    scope: ['profile', 'email'], session: false, prompt: 'select_account',
  })(req, res, next);
});

router.get('/auth/google/callback', (req, res, next) => {
  if (!GOOGLE_ON) return res.redirect('/');
  gpassport.authenticate('google', { session: false }, async (err, user, info) => {
    try {
      if (err) {
        req.session.error = 'Google authentication could not be completed.';
        return res.redirect('/');
      }
      if (!user) {
        req.session.error = (info && info.message) || 'Google authentication could not be completed.';
        return res.redirect('/');
      }
      // Google has already proven the user owns this Gmail, so no emailed code.
      // Disabled and locked accounts were refused in findOrCreateGoogleUser.
      await auth.clearFailedLogins(user.id);
      req.session.flash = 'Signed in.';
      const to = await startSession(req, user, await db.getPermissions(user.role));
      res.redirect(to);
    } catch (e) { next(e); }
  })(req, res, next);
});

// ── FIRST-TIME PROFILE (after Google) ────────────────────────────────────────
router.get('/complete-profile', async (req, res, next) => {
  try {
    if (!req.session.user) return res.redirect('/');
    const me = await db.getUser(req.session.user.id);
    if (!db.needsProfile(me)) return res.redirect(home(me.role));
    res.render('pages/auth/complete-profile', {
      title: 'Complete your profile', profile: me,
      courses: db.COURSES, academicYear: (await db.getSettings()).academicYear,
      formError: null,
    });
  } catch (e) { next(e); }
});

router.post('/complete-profile', async (req, res, next) => {
  try {
    if (!req.session.user) return res.redirect('/');
    const r = await db.completeProfile(req.session.user.id, req.body);
    if (r.error) {
      return res.status(400).render('pages/auth/complete-profile', {
        title: 'Complete your profile',
        profile: Object.assign({}, await db.getUser(req.session.user.id), req.body),
        courses: db.COURSES, academicYear: (await db.getSettings()).academicYear,
        formError: r.error,
      });
    }
    req.session.user  = r.user;
    req.session.perms = await db.getPermissions(r.user.role);
    req.session.flash = 'You are all set. You can request a ticket now.';
    res.redirect(home(r.user.role));
  } catch (e) { next(e); }
});

router.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

module.exports = router;
