'use strict';
/**
 * Proof-of-eligibility uploads for the priority lane.
 *
 * Files are written to /uploads/priority, which is NOT served statically.
 * They can only be read through a route that checks the viewer is either the
 * owner or an admin.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const multer = require('multer');

const DIR = path.join(__dirname, '..', 'uploads', 'priority');
fs.mkdirSync(DIR, { recursive: true });

const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'application/pdf': '.pdf',
};
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DIR),
  filename: (req, file, cb) => {
    const ext  = ALLOWED[file.mimetype] || '.bin';
    const user = req.session && req.session.user ? req.session.user.id : 'x';
    cb(null, `proof-${user}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED[file.mimetype]) return cb(null, true);
    cb(new Error('Only JPG, PNG or PDF files are accepted.'));
  },
});

/** Wraps the single-file middleware so errors become a friendly message. */
function proofUpload(req, res, next) {
  upload.single('proof')(req, res, err => {
    if (!err) return next();
    req.uploadError = err.code === 'LIMIT_FILE_SIZE'
      ? 'That file is larger than 5 MB. Please upload a smaller photo.'
      : err.message;
    next();
  });
}

module.exports = { proofUpload, DIR, MAX_BYTES, ALLOWED };
