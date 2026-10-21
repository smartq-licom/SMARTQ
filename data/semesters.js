'use strict';
/**
 * Semesters a student can ask a Certificate of Grades for: one certificate per
 * semester, each priced on its own (documents.per_semester).
 *
 * SmartQ cannot tell when a student enrolled (the student number does not say
 * it reliably), so every student sees the same list: the 1st and 2nd semester
 * of the last YEARS_BACK school years up to the current semester, newest
 * first. Summer is not offered.
 *
 * The current school year is the one set in Settings (2025-2026); the current
 * semester comes from the month: August to December is the 1st semester,
 * January to July the 2nd.
 */
const YEARS_BACK = 6;                 // covers a 4- or 5-year program and a little more

/** The current school year's first calendar year and semester. */
function currentTerm(academicYear, now = new Date()) {
  const m = /^(\d{4})/.exec(String(academicYear || ''));
  const month = now.getMonth() + 1;
  const sem = month >= 8 ? 1 : 2;
  const ay = m ? Number(m[1]) : (sem === 1 ? now.getFullYear() : now.getFullYear() - 1);
  return { ay, sem };
}

/** [{ value: '2025-1', label: '1st Sem 2025–2026' }, ...] newest first. */
function semesterOptions({ academicYear, now } = {}) {
  const cur = currentTerm(academicYear, now);
  const out = [];
  for (let ay = cur.ay; ay > cur.ay - YEARS_BACK; ay--) {
    for (const sem of [2, 1]) {
      if (ay === cur.ay && sem > cur.sem) continue;        // not started yet
      out.push({ value: `${ay}-${sem}`, label: `${sem === 1 ? '1st' : '2nd'} Sem ${ay}–${ay + 1}` });
    }
  }
  return out;
}

module.exports = { YEARS_BACK, currentTerm, semesterOptions };
