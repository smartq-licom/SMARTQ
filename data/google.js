'use strict';
/**
 * "Sign in with Google" for SmartQ.
 *
 * Only switches on when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set in
 * .env. When they are missing the button is hidden and the rest of the system
 * carries on with email + password as before.
 */
require('dotenv').config();
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const db = require('./db');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const CALLBACK_URL  = process.env.GOOGLE_CALLBACK_URL
                      || `http://localhost:${process.env.APP_PORT || 3000}/auth/google/callback`;

const ENABLED = !!(CLIENT_ID && CLIENT_SECRET);

if (ENABLED) {
  passport.use(new GoogleStrategy(
    {
      clientID:     CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      callbackURL:  CALLBACK_URL,
      scope: ['profile', 'email'],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const result = await db.findOrCreateGoogleUser(profile);
        if (result.error) return done(null, false, { message: result.error });
        return done(null, result.user);
      } catch (e) { return done(e); }
    }
  ));
  console.log('  Google sign-in ready -> ' + CALLBACK_URL);
} else {
  console.log('  Google sign-in OFF (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to enable).');
}

// We keep our own session shape, so store the id only.
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try { done(null, await db.getUser(id)); }
  catch (e) { done(e); }
});

module.exports = { passport, ENABLED, CALLBACK_URL };
