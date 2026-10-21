const express = require('express');
const pool = require('../config/db');
const { authenticateMember } = require('../middleware/auth');
const { getMemberAccess } = require('../services/memberAccess');

const router = express.Router();
const PAGE_SIZE = 10;

// Whitelisted sort columns; user input never goes into SQL directly.
const SORTS = {
  default: 'b.category ASC, b.author ASC, b.title ASC',
  title: 'b.title',
  author: 'b.author',
  price: 'b.price',
};

function escapeLike(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}
function cleanText(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function getPage(req) {
  return Math.min(1000000, Math.max(1, parseInt(req.query.page, 10) || 1));
}
function positiveInt(v) {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}
function serverError(res, label, err) {
  console.error(`${label}:`, err.message);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// GET /api/me/branches : active branches (for filter dropdowns)
router.get('/branches', authenticateMember, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT branch_id, name, address, phone FROM branches WHERE is_active = 1 ORDER BY name'
    );
    res.json({ data: rows });
  } catch (err) {
    serverError(res, 'Me branches error', err);
  }
});

// GET /api/me/books/categories
router.get('/books/categories', authenticateMember, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT category FROM books WHERE is_active = 1 ORDER BY category'
    );
    res.json({ data: rows.map((r) => r.category) });
  } catch (err) {
    serverError(res, 'Me categories error', err);
  }
});

// GET /api/me/books?page=1&search=&category=&branch_id=&availability=available&sort=&dir=
router.get('/books', authenticateMember, async (req, res) => {
  try {
    const conds = ['b.is_active = 1'];
    const params = [];

    const search = cleanText(req.query.search, 100);
    if (search) {
      const like = `%${escapeLike(search)}%`;
      conds.push('(b.title LIKE ? OR b.author LIKE ? OR b.isbn LIKE ?)');
      params.push(like, like, like);
    }

    const category = cleanText(req.query.category, 60);
    if (category) {
      conds.push('b.category = ?');
      params.push(category);
    }

    const branchId = positiveInt(req.query.branch_id);
    if (Number.isNaN(branchId)) {
      return res.status(400).json({ error: 'branch_id must be a positive whole number' });
    }

    const avail = req.query.availability;
    if (avail !== undefined && avail !== '' && avail !== 'available') {
      return res.status(400).json({ error: 'availability must be "available"' });
    }
    const onlyAvailable = avail === 'available';

    if (branchId || onlyAvailable) {
      let sub =
        `EXISTS (SELECT 1 FROM v_branch_availability va
                   JOIN branches br ON br.branch_id = va.branch_id
                  WHERE va.book_id = b.book_id AND br.is_active = 1`;
      if (branchId) {
        sub += ' AND va.branch_id = ?';
        params.push(branchId);
      }
      if (onlyAvailable) sub += ' AND va.available_copies > 0';
      conds.push(sub + ')');
    }

    const sort = req.query.sort;
    if (sort !== undefined && sort !== '' && !Object.prototype.hasOwnProperty.call(SORTS, sort)) {
      return res.status(400).json({ error: 'sort must be one of: title, author, price' });
    }
    const sortKey = sort && sort !== '' ? sort : 'default';
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
    const orderBy = sortKey === 'default' ? SORTS.default : `${SORTS[sortKey]} ${dir}, b.title ASC`;

    const page = getPage(req);
    const where = conds.join(' AND ');

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM books b WHERE ${where}`,
      params
    );

    const [books] = await pool.query(
      `SELECT b.book_id, b.title, b.author, b.category, b.isbn, b.edition, b.publisher,
              b.publication_year, b.price, b.fine_per_day
         FROM books b
        WHERE ${where}
        ORDER BY ${orderBy}, b.book_id
        LIMIT ? OFFSET ?`,
      [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );

    let availability = [];
    if (books.length > 0) {
      const [av] = await pool.query(
        `SELECT va.book_id, va.branch_id, br.name AS branch_name, va.total_copies, va.available_copies
           FROM v_branch_availability va
           JOIN branches br ON br.branch_id = va.branch_id
          WHERE br.is_active = 1 AND va.book_id IN (?)
          ORDER BY br.name`,
        [books.map((b) => b.book_id)]
      );
      availability = av;
    }

    const data = books.map((b) => {
      const branches = availability
        .filter((a) => a.book_id === b.book_id)
        .map((a) => ({
          branch_id: a.branch_id,
          branch_name: a.branch_name,
          total_copies: Number(a.total_copies),
          available_copies: Math.max(0, Number(a.available_copies)),
        }));
      return {
        ...b,
        available_total: branches.reduce((sum, x) => sum + x.available_copies, 0),
        branches,
      };
    });

    res.json({ data, page, page_size: PAGE_SIZE, total, total_pages: Math.ceil(total / PAGE_SIZE) });
  } catch (err) {
    serverError(res, 'Me books error', err);
  }
});

// GET /api/me/ebooks?page=1&search=&category=
router.get('/ebooks', authenticateMember, async (req, res) => {
  try {
    const access = await getMemberAccess(req.member.member_id);

    // Staff-only and inactive ebooks are never listed for members.
    const conds = ['e.is_active = 1', "e.access_policy <> 'staff_only'"];
    const params = [];

    const search = cleanText(req.query.search, 100);
    if (search) {
      const like = `%${escapeLike(search)}%`;
      conds.push('(e.title LIKE ? OR e.author LIKE ?)');
      params.push(like, like);
    }
    const category = cleanText(req.query.category, 60);
    if (category) {
      conds.push('e.category = ?');
      params.push(category);
    }

    const page = getPage(req);
    const where = conds.join(' AND ');

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM ebooks e WHERE ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT e.ebook_id, e.title, e.author, e.category, e.edition, e.publisher,
              e.file_format, e.access_policy
         FROM ebooks e
        WHERE ${where}
        ORDER BY e.category, e.author, e.title
        LIMIT ? OFFSET ?`,
      [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );

    const data = rows.map((e) => ({
      ebook_id: e.ebook_id,
      title: e.title,
      author: e.author,
      category: e.category,
      edition: e.edition,
      publisher: e.publisher,
      file_format: e.file_format,
      access_policy: e.access_policy,
      access_status: access.eligible ? 'available' : 'blocked',
      can_read: access.eligible,
      can_download: access.eligible && e.access_policy === 'download_allowed',
      blocked_reason: access.eligible ? null : access.reason,
    }));

    res.json({ data, page, page_size: PAGE_SIZE, total, total_pages: Math.ceil(total / PAGE_SIZE) });
  } catch (err) {
    serverError(res, 'Me ebooks error', err);
  }
});

module.exports = router;