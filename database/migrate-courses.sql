-- ============================================================================
-- SmartQ migration — course list update
-- ============================================================================
-- Run this ONCE on an existing smartq database (phpMyAdmin > SQL tab, or the
-- mysql client). If you are creating the database fresh from schema.sql you do
-- NOT need this file — schema.sql is already up to date.
--
-- What it does:
--   1. Widens the two `course` columns so the longest program name fits
--      ("BTVTEd - Food Service Management" is 32 characters).
--   2. Clears course values that are no longer programs offered by the college.
--      Those students will be asked to re-select their course the next time
--      they open Account Settings or request a ticket.
-- ============================================================================

USE smartq;

ALTER TABLE users        MODIFY course VARCHAR(40) DEFAULT NULL;
ALTER TABLE transactions MODIFY course VARCHAR(40) DEFAULT NULL;

-- Retire courses that are no longer offered.
UPDATE users
   SET course = NULL
 WHERE course IS NOT NULL
   AND course NOT IN ('BEED','BECE',
                      'BSED - English','BSED - Filipino','BSED - Mathematics',
                      'BSED - Science','BSED - Social Studies',
                      'BSED - Values Education',
                      'BSAB',
                      'BTVTEd - Automotive Technology',
                      'BTVTEd - Electrical Technology',
                      'BTVTEd - Food Service Management');

-- Historical transactions keep whatever course was recorded at the time, so
-- past receipts and reports stay accurate. Nothing to update there.
