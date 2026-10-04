'use strict';
/**
 * Pagination for long lists (accounts, queue history, report results).
 * The database only returns one page (LIMIT/OFFSET); this works out which
 * page, and the "Showing 21-40 of 156" figures the pager shows.
 */
const PER_PAGE = 20;

/** The ?page= number from a request, 1 or more. */
function pageFrom(query) {
  const p = parseInt(query && query.page, 10);
  return p > 0 ? p : 1;
}

/**
 * @param {number} total   rows matching the search/filters
 * @param {number} page    requested page (clamped to what exists)
 * @returns {{total, page, pages, perPage, offset, from, to}}
 */
function paging(total, page, perPage = PER_PAGE) {
  total = Math.max(0, Number(total) || 0);
  const pages = Math.max(1, Math.ceil(total / perPage));
  page = Math.min(Math.max(1, page || 1), pages);
  const offset = (page - 1) * perPage;
  return { total, page, pages, perPage, offset,
           from: total ? offset + 1 : 0, to: Math.min(total, offset + perPage) };
}

module.exports = { PER_PAGE, pageFrom, paging };
