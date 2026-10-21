const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { branchScope, scopeCondition } = require('../middleware/branchScope');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');

const router = express.Router();
const PAGE_SIZE = 10;
const STATUS_FILTERS = ['active', 'inactive', 'all'];
const BOOK_COLUMNS = ['isbn', 'title', 'author', 'category', 'edition', 'publisher', 'publication_year', 'price', 'fine_per_day'];

// Whitelisted sort columns; user input never goes into SQL directly.
const SORTS = {
  category: 'b.category',
  title: 'b.title',
  author: 'b.author',
  price: 'b.price',
  fine: 'b.fine_per_day',
  available: 'COALESCE(inv.available_copies, 0)',
};

// ---------- small helpers ----------
function escapeLike(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}
function cleanText(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function getPage(req) {
  return Math.min(1000000, Math.max(1, parseInt(req.query.page, 10) || 1));
}
function toPositiveInt(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0) return Number(v);
  return NaN;
}
// Optional query integer: null when absent, NaN when invalid.
function intParam(v) {
  return v === undefined || v === '' ? null : toPositiveInt(v);
}
// Optional query amount: null when absent, NaN when invalid.
function moneyParam(v) {
  if (v === undefined || v === '') return null;
  return typeof v === 'string' && /^\d{1,8}(\.\d{1,2})?$/.test(v) ? v : NaN;
}
function parseCopies(v) {
  let n = NaN;
  if (typeof v === 'number' && Number.isInteger(v)) n = v;
  else if (typeof v === 'string' && /^\d{1,5}$/.test(v)) n = Number(v);
  return n >= 0 && n <= 10000 ? n : NaN;
}
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function bad(res, message) {
  return res.status(400).json({ error: message });
}
function handleError(res, label, err) {
  if (err instanceof HttpError) {
    const body = { error: err.message };
    if (err.fields) body.fields = err.fields;
    return res.status(err.status).json(body);
  }
  if (err && err.code === 'ER_DUP_ENTRY') {
    const msg = String(err.message).includes('uq_book_isbn')
      ? 'A book with this ISBN already exists'
      : 'This record already exists';
    return res.status(409).json({ error: msg });
  }
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// ---------- validation ----------
function validateBook(body, partial) {
  const v = {};
  const errors = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  function textField(k, label, max, required) {
    if (!has(k)) {
      if (required && !partial) errors[k] = `${label} is required`;
      return;
    }
    const raw = body[k];
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (required) errors[k] = `${label} is required`;
      else v[k] = null;
      return;
    }
    if (typeof raw !== 'string') {
      errors[k] = `${label} must be text`;
      return;
    }
    const s = raw.trim();
    if (s.length > max) {
      errors[k] = `${label} must be at most ${max} characters`;
      return;
    }
    v[k] = s;
  }

  function moneyField(k, label, intDigits, required) {
    if (!has(k)) {
      if (required && !partial) errors[k] = `${label} is required`;
      return;
    }
    const raw = body[k];
    let s;
    if (typeof raw === 'number' && Number.isFinite(raw)) s = String(raw);
    else if (typeof raw === 'string') s = raw.trim();
    else {
      errors[k] = `${label} must be a number`;
      return;
    }
    const re = new RegExp(`^\\d{1,${intDigits}}(\\.\\d{1,2})?$`);
    if (!re.test(s)) {
      errors[k] = `${label} must be a non-negative amount with at most 2 decimals`;
      return;
    }
    v[k] = Number(s).toFixed(2);
  }

  textField('title', 'Title', 200, true);
  textField('author', 'Author', 120, true);
  textField('category', 'Category', 60, true);
  textField('publisher', 'Publisher', 100, false);

  if (has('edition')) {
    const e = typeof body.edition === 'string' ? body.edition.trim() : '';
    if (!e || e.length > 30) errors.edition = 'Edition is required (max 30 characters)';
    else v.edition = e;
  }

  if (has('isbn')) {
    const raw = body.isbn;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      v.isbn = null;
    } else if (typeof raw !== 'string') {
      errors.isbn = 'ISBN must be text';
    } else {
      const s = raw.trim().replace(/\s+/g, '');
      const digits = s.replace(/-/g, '');
      if (s.length > 17 || !(/^\d{9}[\dXx]$/.test(digits) || /^\d{13}$/.test(digits))) {
        errors.isbn = 'ISBN must have 10 or 13 digits (hyphens allowed, max 17 characters)';
      } else {
        v.isbn = s.toUpperCase();
      }
    }
  }

  if (has('publication_year')) {
    const raw = body.publication_year;
    if (raw === null || raw === '') {
      v.publication_year = null;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1400 || n > 2100) {
        errors.publication_year = 'Publication year must be between 1400 and 2100';
      } else {
        v.publication_year = n;
      }
    }
  }

  moneyField('price', 'Price', 8, true);
  moneyField('fine_per_day', 'Fine per day', 6, false);

  return { values: v, errors };
}

// ---------- data helpers ----------
function serializeBook(b) {
  return { ...b, is_active: !!b.is_active };
}

async function getBook(db, id) {
  const [rows] = await db.execute(
    `SELECT book_id, isbn, title, author, category, edition, publisher, publication_year,
            price, fine_per_day, is_active
       FROM books WHERE book_id = ?`,
    [id]
  );
  return rows[0] ? serializeBook(rows[0]) : null;
}

async function isbnTaken(db, isbn, exceptId) {
  const [rows] = await db.execute(
    "SELECT book_id FROM books WHERE REPLACE(isbn, '-', '') = ? AND book_id <> ? LIMIT 1",
    [isbn.replace(/-/g, ''), exceptId || 0]
  );
  return rows.length > 0;
}

async function defaultFine(db) {
  const [rows] = await db.execute(
    "SELECT setting_value FROM system_settings WHERE setting_key = 'default_fine_per_day'"
  );
  const s = rows[0] ? rows[0].setting_value : '';
  return /^\d{1,6}(\.\d{1,2})?$/.test(s) ? Number(s).toFixed(2) : '5.00';
}

// ---------- READ ----------

// GET /api/books/categories
router.get('/categories', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT DISTINCT category FROM books ORDER BY category');
    res.json({ data: rows.map((r) => r.category) });
  } catch (err) {
    handleError(res, 'Book categories error', err);
  }
});

// GET /api/books?page=&book_id=&title=&author=&category=&isbn=&edition=&min_price=&max_price=
//                &min_fine=&max_fine=&availability=&status=&branch_id=&sort=&dir=
router.get('/', authenticate, branchScope, async (req, res) => {
  try {
    const q = req.query;
    const conds = [];
    const params = [];

    const bookId = intParam(q.book_id);
    if (Number.isNaN(bookId)) return bad(res, 'book_id must be a positive whole number');
    if (bookId) {
      conds.push('b.book_id = ?');
      params.push(bookId);
    }

    for (const [key, col, max] of [['title', 'b.title', 200], ['author', 'b.author', 120], ['edition', 'b.edition', 30]]) {
      const s = cleanText(q[key], max);
      if (s) {
        conds.push(`${col} LIKE ?`);
        params.push(`%${escapeLike(s)}%`);
      }
    }

    // ISBN is compared without hyphens so either style of typing finds it.
    const isbn = cleanText(q.isbn, 20).replace(/[-\s]/g, '');
    if (isbn) {
      conds.push("REPLACE(b.isbn, '-', '') LIKE ?");
      params.push(`%${escapeLike(isbn)}%`);
    }

    const category = cleanText(q.category, 60);
    if (category) {
      conds.push('b.category = ?');
      params.push(category);
    }

    for (const [key, col, op] of [
      ['min_price', 'b.price', '>='],
      ['max_price', 'b.price', '<='],
      ['min_fine', 'b.fine_per_day', '>='],
      ['max_fine', 'b.fine_per_day', '<='],
    ]) {
      const m = moneyParam(q[key]);
      if (Number.isNaN(m)) return bad(res, `${key} must be a non-negative amount`);
      if (m !== null) {
        conds.push(`${col} ${op} ?`);
        params.push(m);
      }
    }

    const avail = q.availability;
    if (avail !== undefined && avail !== '' && avail !== 'available' && avail !== 'unavailable') {
      return bad(res, 'availability must be "available" or "unavailable"');
    }
    if (avail === 'available') conds.push('COALESCE(inv.available_copies, 0) > 0');
    if (avail === 'unavailable') conds.push('COALESCE(inv.available_copies, 0) = 0');

    const status = q.status === undefined || q.status === '' ? 'active' : q.status;
    if (!STATUS_FILTERS.includes(status)) return bad(res, 'status must be active, inactive or all');
    if (status === 'active') conds.push('b.is_active = 1');
    if (status === 'inactive') conds.push('b.is_active = 0');

    const sort = q.sort;
    if (sort !== undefined && sort !== '' && !Object.prototype.hasOwnProperty.call(SORTS, sort)) {
      return bad(res, 'sort must be one of: category, title, author, price, fine, available');
    }
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
    const orderBy =
      !sort || sort === 'category'
        ? `b.category ${dir}, b.author ASC, b.title ASC`
        : `${SORTS[sort]} ${dir}, b.title ASC`;

    // Stock numbers are limited to the caller's branch scope inside the database.
    const inv = scopeCondition(req, 'va.branch_id');
    const invJoin =
      `LEFT JOIN (SELECT va.book_id, SUM(va.total_copies) AS total_copies, SUM(va.on_loan) AS on_loan,
                         SUM(GREATEST(va.available_copies, 0)) AS available_copies
                    FROM v_branch_availability va
                   WHERE ${inv.sql}
                   GROUP BY va.book_id) inv ON inv.book_id = b.book_id`;
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const page = getPage(req);

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM books b ${invJoin} ${where}`,
      [...inv.params, ...params]
    );

    const [rows] = await pool.query(
      `SELECT b.book_id, b.title, b.author, b.category, b.isbn, b.edition, b.publisher,
              b.publication_year, b.price, b.fine_per_day, b.is_active,
              COALESCE(inv.total_copies, 0) AS total_copies,
              COALESCE(inv.on_loan, 0) AS on_loan,
              COALESCE(inv.available_copies, 0) AS available_copies
         FROM books b
         ${invJoin}
         ${where}
        ORDER BY ${orderBy}, b.book_id
        LIMIT ? OFFSET ?`,
      [...inv.params, ...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );

    res.json({
      data: rows.map((r) => ({
        ...r,
        is_active: !!r.is_active,
        total_copies: Number(r.total_copies),
        on_loan: Number(r.on_loan),
        available_copies: Number(r.available_copies),
      })),
      page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
      scope_branch_id: req.scope.branchId,
    });
  } catch (err) {
    handleError(res, 'Books list error', err);
  }
});

// GET /api/books/:id  (stock rows limited to the caller's scope)
router.get('/:id', authenticate, branchScope, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Book ID must be a positive whole number');
  try {
    const book = await getBook(pool, id);
    if (!book) return res.status(404).json({ error: 'Book not found' });

    const sc = scopeCondition(req, 'va.branch_id');
    const [inv] = await pool.query(
      `SELECT va.branch_id, br.name AS branch_name, va.total_copies, va.on_loan,
              GREATEST(va.available_copies, 0) AS available_copies
         FROM v_branch_availability va
         JOIN branches br ON br.branch_id = va.branch_id
        WHERE va.book_id = ? AND ${sc.sql}
        ORDER BY br.name`,
      [id, ...sc.params]
    );
    res.json({
      book,
      branches: inv.map((r) => ({
        ...r,
        total_copies: Number(r.total_copies),
        on_loan: Number(r.on_loan),
        available_copies: Number(r.available_copies),
      })),
    });
  } catch (err) {
    handleError(res, 'Book detail error', err);
  }
});

// ---------- WRITE: catalogue (admin only) ----------

// POST /api/books
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  if (!isPlainObject(req.body)) return bad(res, 'Send the book details as a JSON object');
  const { values, errors } = validateBook(req.body, false);
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please correct the highlighted fields', fields: errors });
  }
  try {
    const id = await withTransaction(async (conn) => {
      if (values.isbn && (await isbnTaken(conn, values.isbn, 0))) {
        throw new HttpError(409, 'A book with this ISBN already exists', { isbn: 'Already in use' });
      }
      const fine = values.fine_per_day !== undefined ? values.fine_per_day : await defaultFine(conn);
      const [r] = await conn.execute(
        `INSERT INTO books (isbn, title, author, category, edition, publisher, publication_year, price, fine_per_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          values.isbn ?? null,
          values.title,
          values.author,
          values.category,
          values.edition ?? '1st',
          values.publisher ?? null,
          values.publication_year ?? null,
          values.price,
          fine,
        ]
      );
      await logAudit(conn, req.user.user_id, 'book_created', 'book', r.insertId, `${values.title} / ${values.author}`);
      return r.insertId;
    });
    res.status(201).json({ book: await getBook(pool, id) });
  } catch (err) {
    handleError(res, 'Create book error', err);
  }
});

// PATCH /api/books/:id  (only the fields you send are changed)
router.patch('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Book ID must be a positive whole number');
  if (!isPlainObject(req.body)) return bad(res, 'Send the changes as a JSON object');
  const { values, errors } = validateBook(req.body, true);
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please correct the highlighted fields', fields: errors });
  }
  if (Object.keys(values).length === 0) return bad(res, 'No changes supplied');

  try {
    const changed = await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT * FROM books WHERE book_id = ? FOR UPDATE', [id]);
      const old = rows[0];
      if (!old) throw new HttpError(404, 'Book not found');
      if (values.isbn && (await isbnTaken(conn, values.isbn, id))) {
        throw new HttpError(409, 'A book with this ISBN already exists', { isbn: 'Already in use' });
      }

      const sets = [];
      const sp = [];
      const notes = [];
      for (const key of Object.keys(values)) {
        if (!BOOK_COLUMNS.includes(key)) continue;
        const oldVal = old[key] === null ? '' : String(old[key]);
        const newVal = values[key] === null ? '' : String(values[key]);
        if (oldVal === newVal) continue;
        sets.push(`${key} = ?`);
        sp.push(values[key]);
        notes.push(`${key}: ${oldVal || '(none)'} -> ${newVal || '(none)'}`);
      }
      if (sets.length) {
        await conn.execute(`UPDATE books SET ${sets.join(', ')} WHERE book_id = ?`, [...sp, id]);
        await logAudit(conn, req.user.user_id, 'book_updated', 'book', id, notes.join('; '));
      }
      return sets.length > 0;
    });
    res.json({ book: await getBook(pool, id), changed });
  } catch (err) {
    handleError(res, 'Update book error', err);
  }
});

// PATCH /api/books/:id/status   body: { "is_active": true | false }   (archive / restore)
router.patch('/:id/status', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Book ID must be a positive whole number');
  if (!isPlainObject(req.body) || typeof req.body.is_active !== 'boolean') {
    return bad(res, 'is_active must be true or false');
  }
  const active = req.body.is_active;
  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT is_active FROM books WHERE book_id = ? FOR UPDATE', [id]);
      if (!rows[0]) throw new HttpError(404, 'Book not found');
      if (!!rows[0].is_active !== active) {
        await conn.execute('UPDATE books SET is_active = ? WHERE book_id = ?', [active ? 1 : 0, id]);
        await logAudit(conn, req.user.user_id, active ? 'book_restored' : 'book_archived', 'book', id, null);
      }
    });
    res.json({ book: await getBook(pool, id) });
  } catch (err) {
    handleError(res, 'Book status error', err);
  }
});

// DELETE /api/books/:id  (only a title with no history and no stock; otherwise archive it)
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Book ID must be a positive whole number');
  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.execute('SELECT title FROM books WHERE book_id = ? FOR UPDATE', [id]);
      if (!rows[0]) throw new HttpError(404, 'Book not found');

      const [[loans]] = await conn.execute('SELECT COUNT(*) AS n FROM loans WHERE book_id = ?', [id]);
      const [[incidents]] = await conn.execute('SELECT COUNT(*) AS n FROM incidents WHERE book_id = ?', [id]);
      if (loans.n > 0 || incidents.n > 0) {
        throw new HttpError(409, 'This book has loan or incident history and cannot be deleted. Archive it instead.');
      }
      const [[stock]] = await conn.execute(
        'SELECT COALESCE(SUM(total_copies), 0) AS n FROM branch_inventory WHERE book_id = ?',
        [id]
      );
      if (Number(stock.n) > 0) {
        throw new HttpError(409, 'Set the number of copies to 0 at every branch before deleting this book.');
      }

      await conn.execute('DELETE FROM branch_inventory WHERE book_id = ?', [id]);
      await conn.execute('DELETE FROM books WHERE book_id = ?', [id]);
      await logAudit(conn, req.user.user_id, 'book_deleted', 'book', id, rows[0].title);
    });
    res.json({ message: 'Book deleted' });
  } catch (err) {
    handleError(res, 'Delete book error', err);
  }
});

// ---------- WRITE: branch inventory (admin: any branch, staff: own branch only) ----------

// PUT /api/books/:id/inventory   body: { "total_copies": 3, "branch_id": 2 (admin only) }
router.put('/:id/inventory', authenticate, requireRole('admin', 'staff'), async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Book ID must be a positive whole number');
  if (!isPlainObject(req.body)) return bad(res, 'Send the details as a JSON object');

  const copies = parseCopies(req.body.total_copies);
  if (Number.isNaN(copies)) return bad(res, 'total_copies must be a whole number from 0 to 10000');

  let branchId;
  if (req.user.role === 'staff') {
    branchId = req.user.branch_id; // from the database, never from the request
    const sent = req.body.branch_id;
    if (sent !== undefined && sent !== null && toPositiveInt(sent) !== branchId) {
      return res.status(403).json({ error: 'You can only change inventory for your own branch' });
    }
  } else {
    branchId = toPositiveInt(req.body.branch_id);
    if (Number.isNaN(branchId)) return bad(res, 'branch_id is required for administrators');
  }

  try {
    const result = await withTransaction(async (conn) => {
      const [books] = await conn.execute('SELECT is_active FROM books WHERE book_id = ?', [id]);
      if (!books[0]) throw new HttpError(404, 'Book not found');
      if (!books[0].is_active) throw new HttpError(409, 'This book is archived. Restore it before changing stock.');

      const [branches] = await conn.execute('SELECT is_active FROM branches WHERE branch_id = ?', [branchId]);
      if (!branches[0]) throw new HttpError(404, 'Branch not found');
      if (!branches[0].is_active) throw new HttpError(409, 'This branch is inactive');

      // Locks the stock row; loan issue/return will lock the same row, so they cannot interleave.
      const [cur] = await conn.execute(
        'SELECT total_copies FROM branch_inventory WHERE branch_id = ? AND book_id = ? FOR UPDATE',
        [branchId, id]
      );
      const [[ol]] = await conn.execute(
        'SELECT COUNT(*) AS n FROM loans WHERE branch_id = ? AND book_id = ? AND return_date IS NULL FOR UPDATE' ,
        [branchId, id]
      );
      const onLoan = Number(ol.n);
      if (copies < onLoan) {
        throw new HttpError(409, `Cannot set copies below ${onLoan}: ${onLoan} copy(ies) are currently on loan at this branch.`);
      }

      const oldCopies = cur[0] ? Number(cur[0].total_copies) : 0;
      if (cur[0]) {
        await conn.execute('UPDATE branch_inventory SET total_copies = ? WHERE branch_id = ? AND book_id = ?', [copies, branchId, id]);
      } else if (copies > 0) {
        await conn.execute('INSERT INTO branch_inventory (branch_id, book_id, total_copies) VALUES (?, ?, ?)', [branchId, id, copies]);
      }
      if (oldCopies !== copies) {
        await logAudit(conn, req.user.user_id, 'inventory_set', 'book', id, `branch ${branchId}: ${oldCopies} -> ${copies}`);
      }
      return { book_id: id, branch_id: branchId, total_copies: copies, on_loan: onLoan, available_copies: copies - onLoan };
    });
    res.json({ inventory: result });
  } catch (err) {
    handleError(res, 'Inventory error', err);
  }
});

module.exports = router;