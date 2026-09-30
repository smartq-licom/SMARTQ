'use strict';
/**
 * Email sending for SmartQ.
 *
 * Used only for priority-lane decision notices. Sign-in no longer sends email:
 * students authenticate with Google, which has already verified the address.
 *
 * If SMTP_HOST / SMTP_USER / SMTP_PASS are set in .env, real mail is sent.
 * Otherwise the message is printed to the terminal, so the system stays fully
 * testable without an inbox.
 */
require('dotenv').config();
const nodemailer = require('nodemailer');

const HAS_SMTP = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;
if (HAS_SMTP) {
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true', // true for port 465
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  transporter.verify()
    .then(() => console.log('  Mail ready -> ' + process.env.SMTP_HOST))
    .catch(e => console.error('  Mail error:', e.message));
} else {
  console.log('  Mail NOT configured - notification emails will print in this terminal.');
}

const FROM = process.env.MAIL_FROM || 'SmartQ <no-reply@smartq.local>';

async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    // Development fallback only. With SMTP configured nothing is ever logged.
    console.log('\n  ---------------- EMAIL (not sent, SMTP unset) ----------------');
    console.log('  To      : ' + to);
    console.log('  Subject : ' + subject);
    console.log('  ' + String(text).split('\n').join('\n  '));
    console.log('  --------------------------------------------------------------\n');
    return { delivered: false, preview: true };
  }
  await transporter.sendMail({ from: FROM, to, subject, text, html });
  return { delivered: true };
}

/**
 * One-time code email. The wording changes with the purpose so the recipient
 * can tell a login code from a password-reset code.
 */
const OTP_COPY = {
  registration:     { subject: 'Verify your SmartQ account',   line: 'Your verification code is' },
  login:            { subject: 'Your SmartQ login code',        line: 'Your login verification code is' },
  password_reset:   { subject: 'Reset your SmartQ password',    line: 'Your password reset verification code is' },
  account_recovery: { subject: 'SmartQ account recovery',       line: 'Your account recovery verification code is' },
  email_change:     { subject: 'Confirm your new SmartQ email', line: 'Your email change verification code is' },
};

async function sendOtp(to, name, code, purpose, minutes) {
  const c = OTP_COPY[purpose] || OTP_COPY.login;
  const text =
`SmartQ - Libon Community College

Hi ${name},

${c.line}:

    ${code}

This code expires in ${minutes} minutes and can be used once.

If you did not request this, ignore this email and your account stays safe.
Never share this code with anyone. SmartQ staff will never ask for it.

This is an automated message. Please do not reply.`;

  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0f172a">
    <h2 style="margin:0 0 4px">SmartQ</h2>
    <p style="margin:0 0 20px;color:#64748b;font-size:13px">Libon Community College</p>
    <p style="font-size:14px">Hi ${name}, ${c.line.toLowerCase()}:</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f1f5f9;
                border-radius:10px;padding:18px;text-align:center;margin:18px 0">${code}</div>
    <p style="font-size:13px;color:#64748b">
      Expires in ${minutes} minutes and can be used once.<br>
      If you did not request this, ignore this email.<br>
      <strong>Never share this code.</strong> SmartQ staff will never ask for it.
    </p>
    <p style="font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px">
      Automated message - please do not reply.
    </p>
  </div>`;

  return sendMail({ to, subject: c.subject, text, html });
}

/** Your number is up. */
async function sendCalled(to, name, t) {
  const where = t.windowLabel ? `at ${t.windowLabel}` : `at the ${t.department}`;
  const subject = `SmartQ: ${t.ticketNo} is being called now`;
  const text =
`SmartQ - Libon Community College

Hi ${name},

Your number ${t.ticketNo} is being called now ${where}.

Please proceed to the window. If you are not there shortly the number may be
released and you would need to request a new one.

This is an automated message. Please do not reply.`;

  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#303841">
    <h2 style="margin:0 0 4px">SmartQ</h2>
    <p style="margin:0 0 20px;color:#3A4750;font-size:13px">Libon Community College</p>
    <p style="font-size:14px">Hi ${name}, your number is being called now.</p>
    <div style="font-size:40px;font-weight:800;letter-spacing:2px;background:#E7F1FA;color:#1A6CAE;
                border-radius:10px;padding:20px;text-align:center;margin:18px 0">${t.ticketNo}</div>
    <p style="font-size:14px;text-align:center;margin:0 0 18px"><strong>${where}</strong></p>
    <p style="font-size:13px;color:#3A4750">
      Please proceed to the window. If you are not there shortly the number may be
      released and you would need to request a new one.
    </p>
    <p style="font-size:11px;color:#78838C;border-top:1px solid #DFE2E6;padding-top:12px">
      Automated message - please do not reply.
    </p>
  </div>`;

  return sendMail({ to, subject, text, html });
}

/** Told the student their priority request was decided. */
async function sendPriorityDecision(to, name, category, approved, reason) {
  const label = { pwd: 'PWD', senior: 'Senior Citizen', pregnant: 'Pregnant' }[category] || category;
  const subject = approved
    ? `Your SmartQ priority lane request was approved`
    : `Your SmartQ priority lane request needs attention`;
  const text = approved
    ? `Hi ${name},\n\nYour ${label} priority lane request has been approved.\nYour future SmartQ tickets will automatically join the priority lane.\n\nLibon Community College`
    : `Hi ${name},\n\nYour ${label} priority lane request was not approved.\n\nReason: ${reason || 'Not stated'}\n\nYou can upload clearer proof and submit again from your SmartQ dashboard.\n\nLibon Community College`;
  return sendMail({ to, subject, text, html: `<pre style="font-family:Inter,Arial,sans-serif">${text}</pre>` });
}

module.exports = { sendMail, sendOtp, sendCalled, sendPriorityDecision, HAS_SMTP };
