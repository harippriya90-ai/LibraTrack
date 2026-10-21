const pool = require('../config/db');
const { scopeCondition } = require('../middleware/branchScope');
const { logAudit } = require('./dbHelpers');
const { toCsv } = require('./csv');
const { expireStalePayments } = require('./paymentExpiry');

const PAGE_SIZE = 10;
const CSV_MAX_ROWS = 50000;

// ---------- helpers ----------
function escapeLike(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}
function text(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
const present = (v) => v !== undefined && v !== '';
function toPositiveInt(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0) return Number(v);
  return NaN;
}
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Turns the query string into a safe WHERE clause using the report definition's filter list.
// Every value goes through a placeholder; column names and SQL fragments come only from the definitions.
function buildQuery(def, req) {
  const q = req.query;
  const conds = [...(def.baseWhere || [])];
  const params = [];

  if (def.scopeColumn) {
    const sc = scopeCondition(req, def.scopeColumn);
    conds.push(sc.sql);
    params.push(...sc.params);
  }

  for (const f of def.filters || []) {
    const raw = q[f.name];
    switch (f.type) {
      case 'int': {
        if (!present(raw)) break;
        const n = toPositiveInt(raw);
        if (Number.isNaN(n)) return { error: `${f.name} must be a positive whole number` };
        conds.push(f.sql);
        params.push(n);
        break;
      }
      case 'like': {
        const s = text(raw, f.max || 100);
        if (!s) break;
        const like = `%${escapeLike(s)}%`;
        conds.push(`(${f.cols.map((c) => `${c} LIKE ?`).join(' OR ')})`);
        f.cols.forEach(() => params.push(like));
        break;
      }
      case 'isbn': {
        // Compared without hyphens so either way of typing finds it.
        const s = text(raw, 20).replace(/[-\s]/g, '');
        if (!s) break;
        conds.push(`REPLACE(${f.col}, '-', '') LIKE ?`);
        params.push(`%${escapeLike(s)}%`);
        break;
      }
      case 'exact': {
        const s = text(raw, f.max || 60);
        if (!s) break;
        conds.push(f.sql);
        params.push(s);
        break;
      }
      case 'enum': {
        const isList = Array.isArray(f.values);
        const keys = isList ? f.values : Object.keys(f.values);
        const key = present(raw) ? raw : f.default;
        if (key === undefined) break;
        if (typeof key !== 'string' || !keys.includes(key)) {
          return { error: `${f.name} must be one of: ${keys.join(', ')}` };
        }
        if (isList) {
          conds.push(f.sql);
          params.push(key);
        } else {
          conds.push(f.values[key]);
        }
        break;
      }
      case 'date': {
        if (!present(raw)) break;
        if (!isValidDate(raw)) return { error: `${f.name} must be a valid date (YYYY-MM-DD)` };
        conds.push(f.sql);
        params.push(raw);
        break;
      }
      case 'money': {
        if (!present(raw)) break;
        if (typeof raw !== 'string' || !/^\d{1,8}(\.\d{1,2})?$/.test(raw)) {
          return { error: `${f.name} must be a non-negative amount` };
        }
        conds.push(f.sql);
        params.push(raw);
        break;
      }
      case 'days': {
        let n = f.default;
        if (present(raw)) {
          n = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
          if (Number.isNaN(n) || n < f.min || n > f.max) {
            return { error: `${f.name} must be a whole number from ${f.min} to ${f.max}` };
          }
        }
        conds.push(f.sql);
        params.push(n);
        break;
      }
      default:
        break;
    }
  }

  if (present(q.sort) && !Object.prototype.hasOwnProperty.call(def.sorts, q.sort)) {
    return { error: `sort must be one of: ${Object.keys(def.sorts).join(', ')}` };
  }
  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  const orderBy = present(q.sort) ? `${def.sorts[q.sort]} ${dir}, ${def.tieBreaker}` : def.defaultOrder;

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return { where, params, orderBy };
}

// Returns an Express handler for a report definition.
function makeReport(def) {
  const shape = def.shape || ((r) => r);
  return async (req, res) => {
    try {
      const f = buildQuery(def, req);
      if (f.error) return res.status(400).json({ error: f.error });
      const format = present(req.query.format) ? req.query.format : 'json';
      if (format !== 'json' && format !== 'csv') {
        return res.status(400).json({ error: 'format must be json or csv' });
      }

      if (def.sweepPayments) await expireStalePayments();
      const [[now]] = await pool.query('SELECT NOW() AS now');
      const scopeLabel = def.scopeColumn && req.scope.branchId !== null ? req.scope.branchId : 'all';

      if (format === 'csv') {
        // Every matching row, not only the visible page.
        const [rows] = await pool.query(
          `SELECT ${def.select} ${def.from} ${f.where} ORDER BY ${f.orderBy} LIMIT ?`,
          [...f.params, CSV_MAX_ROWS]
        );
        const stamp = String(now.now).replace(/\D/g, '');
        await logAudit(pool, req.user.user_id, 'report_exported', 'report', null,
          `${def.name}; ${rows.length} rows; branch scope ${scopeLabel}`);
        res.set({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${def.fileName}-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}.csv"`,
          'X-Report-Generated': now.now,
          'Cache-Control': 'private, no-store',
        });
        return res.send(toCsv(def.csv, rows.map(shape)));
      }

      const page = Math.min(1000000, Math.max(1, parseInt(req.query.page, 10) || 1));
      const [[agg]] = await pool.query(
        `SELECT ${def.totals || 'COUNT(*) AS total'} ${def.from} ${f.where}`,
        f.params
      );
      const { total, ...rest } = agg;
      const totals = def.totalsShape
        ? def.totalsShape(rest)
        : Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, Number(v)]));
      const [rows] = await pool.query(
        `SELECT ${def.select} ${def.from} ${f.where} ORDER BY ${f.orderBy} LIMIT ? OFFSET ?`,
        [...f.params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
      );

      res.json({
        report: def.name,
        generated_at: now.now,
        data: rows.map(shape),
        page,
        page_size: PAGE_SIZE,
        total: Number(total),
        total_pages: Math.ceil(Number(total) / PAGE_SIZE),
        totals,
        scope_branch_id: def.scopeColumn ? req.scope.branchId : null,
      });
    } catch (err) {
      console.error(`Report ${def.name} error:`, err.message);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
}

module.exports = { makeReport };