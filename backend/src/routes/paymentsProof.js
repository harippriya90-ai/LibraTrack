const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { HttpError, withTransaction, logAudit } = require('../services/dbHelpers');
const { expireStalePayments } = require('../services/paymentExpiry');

const router = express.Router();

// Private folder, outside anything served as static files.
const PROOF_DIR = path.resolve(__dirname, '..', '..', 'storage', 'proofs');
fs.mkdirSync(PROOF_DIR, { recursive: true });

const MAX_BYTES = 5 * 1024 * 1024;
const SERVE_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];

// The file is held in memory (max 5 MB), checked, and only then written to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5, parts: 6 },
});

// ---------- helpers ----------
function toPositiveInt(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0) return Number(v);
  return NaN;
}
function bad(res, message) {
  return res.status(400).json({ error: message });
}
function handleError(res, label, err) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// The type comes from the file's first bytes, never from its name or the client's claim.
function detectType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  return null;
}

// Display name only: no path parts, safe characters, extension forced to the detected type.
function cleanName(original, ext) {
  const last = String(original || '').split(/[\\/]/).pop();
  const base = last.normalize('NFKC').replace(/[^\w.\- ]+/g, '_');
  const stem = base.replace(/\.[^.]*$/, '').trim().slice(0, 100);
  return `${stem || 'proof'}.${ext}`;
}

function uploadError(res, err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File is too large. The maximum size is 5 MB.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return bad(res, 'Send exactly one file in the "proof" field');
    }
    return bad(res, 'The upload was not accepted. Send one file in the "proof" field.');
  }
  return bad(res, 'The upload could not be read. Send multipart/form-data with a file in the "proof" field.');
}

async function safeUnlink(storedName) {
  if (!storedName) return;
  const filePath = path.resolve(PROOF_DIR, path.basename(storedName));
  if (path.dirname(filePath) !== PROOF_DIR) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not delete proof file:', err.message);
  }
}

// Cheap checks BEFORE the upload is read, so unauthorized callers cannot push data at the server.
async function loadForUpload(req, res, next) {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Payment ID must be a positive whole number');
  try {
    await expireStalePayments();
    const [rows] = await pool.execute(
      'SELECT branch_id, status, proof_stored_name FROM payment_requests WHERE request_id = ?',
      [id]
    );
    const pr = rows[0];
    if (!pr) return res.status(404).json({ error: 'Payment request not found' });
    if (req.user.role === 'staff' && pr.branch_id !== req.user.branch_id) {
      return res.status(403).json({ error: 'This payment request belongs to another branch' });
    }
    if (pr.status !== 'pending') {
      return res.status(409).json({ error: 'Proof can only be attached while the request is pending.' });
    }
    if (pr.proof_stored_name) {
      return res.status(409).json({ error: 'This request already has a proof. Remove it first to attach a different one.' });
    }
    req.paymentId = id;
    next();
  } catch (err) {
    handleError(res, 'Proof precheck error', err);
  }
}

// ---------- POST /api/payments/:id/proof ----------
router.post(
  '/:id/proof',
  authenticate,
  loadForUpload,
  (req, res, next) => {
    upload.single('proof')(req, res, (err) => {
      if (err) return uploadError(res, err);
      next();
    });
  },
  async (req, res) => {
    const id = req.paymentId;
    if (!req.file) return bad(res, 'Attach a file in the "proof" field');

    const type = detectType(req.file.buffer);
    if (!type) {
      return res.status(415).json({ error: 'Only PNG, JPEG or PDF files are accepted.' });
    }

    const stored = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
    const target = path.join(PROOF_DIR, stored);
    const original = cleanName(req.file.originalname, type.ext);

    try {
      await fs.promises.writeFile(target, req.file.buffer, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      console.error('Could not save proof file:', err.message);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }

    try {
      await withTransaction(async (conn) => {
        // Re-check under a lock: the state may have changed while the file was uploading.
        const [rows] = await conn.execute(
          `SELECT branch_id, status, proof_stored_name, (expires_at <= NOW()) AS past_expiry
             FROM payment_requests WHERE request_id = ? FOR UPDATE`,
          [id]
        );
        const pr = rows[0];
        if (!pr) throw new HttpError(404, 'Payment request not found');
        if (req.user.role === 'staff' && pr.branch_id !== req.user.branch_id) {
          throw new HttpError(403, 'This payment request belongs to another branch');
        }
        if (pr.status !== 'pending' || pr.past_expiry) {
          throw new HttpError(409, 'Proof can only be attached while the request is pending.');
        }
        if (pr.proof_stored_name) {
          throw new HttpError(409, 'This request already has a proof. Remove it first to attach a different one.');
        }
        await conn.execute(
          'UPDATE payment_requests SET proof_stored_name = ?, proof_original_name = ?, proof_mime = ? WHERE request_id = ?',
          [stored, original, type.mime, id]
        );
        await logAudit(conn, req.user.user_id, 'payment_proof_uploaded', 'payment_request', id,
          `${type.mime}, ${req.file.size} bytes`);
      });
    } catch (err) {
      await safeUnlink(stored); // no orphan file if the database step failed
      return handleError(res, 'Proof upload error', err);
    }

    res.status(201).json({
      proof: { has_proof: true, original_name: original, mime: type.mime, size_bytes: req.file.size },
      note: 'A proof file is only a record. The payment stays pending until an administrator verifies it.',
    });
  }
);

// ---------- GET /api/payments/:id/proof ----------
router.get('/:id/proof', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Payment ID must be a positive whole number');

  try {
    const [rows] = await pool.execute(
      'SELECT branch_id, proof_stored_name, proof_original_name, proof_mime FROM payment_requests WHERE request_id = ?',
      [id]
    );
    const pr = rows[0];
    if (!pr) return res.status(404).json({ error: 'Payment request not found' });
    if (req.user.role === 'staff' && pr.branch_id !== req.user.branch_id) {
      return res.status(403).json({ error: 'This payment request belongs to another branch' });
    }
    if (!pr.proof_stored_name) {
      return res.status(404).json({ error: 'This payment request has no proof attached' });
    }

    // The path comes only from the database's random stored name and must stay inside PROOF_DIR.
    const filePath = path.resolve(PROOF_DIR, path.basename(pr.proof_stored_name));
    if (path.dirname(filePath) !== PROOF_DIR) {
      console.error('Proof path escaped storage folder:', pr.proof_stored_name);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }

    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      console.error('Proof file missing:', pr.proof_stored_name);
      return res.status(404).json({ error: 'The proof file is currently unavailable.' });
    }

    const known = SERVE_TYPES.includes(pr.proof_mime);
    const asDownload = req.query.download === '1' || !known;
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('Proof stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
      else res.destroy();
    });
    stream.once('open', () => {
      res.set({
        'Content-Type': known ? pr.proof_mime : 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `${asDownload ? 'attachment' : 'inline'}; filename="${pr.proof_original_name || 'proof'}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store',
      });
      stream.pipe(res);
    });
  } catch (err) {
    handleError(res, 'Proof download error', err);
  }
});

// ---------- DELETE /api/payments/:id/proof ----------
router.delete('/:id/proof', authenticate, async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) return bad(res, 'Payment ID must be a positive whole number');

  try {
    await expireStalePayments();
    const stored = await withTransaction(async (conn) => {
      const [rows] = await conn.execute(
        `SELECT branch_id, status, proof_stored_name, (expires_at <= NOW()) AS past_expiry
           FROM payment_requests WHERE request_id = ? FOR UPDATE`,
        [id]
      );
      const pr = rows[0];
      if (!pr) throw new HttpError(404, 'Payment request not found');
      if (req.user.role === 'staff' && pr.branch_id !== req.user.branch_id) {
        throw new HttpError(403, 'This payment request belongs to another branch');
      }
      if (!pr.proof_stored_name) throw new HttpError(404, 'This payment request has no proof attached');
      if (pr.status !== 'pending' || pr.past_expiry) {
        throw new HttpError(409, 'Proof can only be removed while the request is pending.');
      }
      await conn.execute(
        'UPDATE payment_requests SET proof_stored_name = NULL, proof_original_name = NULL, proof_mime = NULL WHERE request_id = ?',
        [id]
      );
      await logAudit(conn, req.user.user_id, 'payment_proof_removed', 'payment_request', id, null);
      return pr.proof_stored_name;
    });
    await safeUnlink(stored);
    res.json({ has_proof: false });
  } catch (err) {
    handleError(res, 'Proof removal error', err);
  }
});

module.exports = router;