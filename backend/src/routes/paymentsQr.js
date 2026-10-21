const express = require('express');
const QRCode = require('qrcode');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { expireStalePayments } = require('../services/paymentExpiry');

const router = express.Router();
const REF_RE = /^[0-9A-Fa-f]{24}$/;
const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 2, width: 320 };

const NOTES = {
  pending: 'Awaiting verification. This QR code identifies the request only; it is not proof that money was transferred.',
  successful: 'Payment verified and recorded by the library.',
  rejected: 'This payment request was rejected.',
  expired: 'This payment request expired. A new request is needed.',
};

const COLUMNS = `pr.request_id, pr.reference_no, pr.branch_id, b.name AS branch_name,
       pr.member_id, m.full_name AS member_name, p.name AS plan_name, pr.request_type, pr.amount,
       pr.method, pr.submitted_txn_id, pr.verification_txn_id, pr.status,
       pr.requested_at, pr.expires_at, pr.verified_at`;
const FROM_SQL = `FROM payment_requests pr
       JOIN members m ON m.member_id = pr.member_id
       JOIN branches b ON b.branch_id = pr.branch_id
       JOIN membership_plans p ON p.plan_id = pr.plan_id`;

// ---------- helpers ----------
function toPositiveInt(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) > 0) return Number(v);
  return NaN;
}
function bad(res, message) {
  return res.status(400).json({ error: message });
}
function serverError(res, label, err) {
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
// Shows only the last 4 characters of a transaction ID.
function maskId(v) {
  if (!v) return null;
  const s = String(v);
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;
}

// Loads the payment named in :id and checks the caller may see it. Sends the error response itself.
async function loadAuthorized(req, res) {
  const id = toPositiveInt(req.params.id);
  if (Number.isNaN(id)) {
    bad(res, 'Payment ID must be a positive whole number');
    return null;
  }
  await expireStalePayments();
  const [rows] = await pool.execute(`SELECT ${COLUMNS} ${FROM_SQL} WHERE pr.request_id = ?`, [id]);
  const pr = rows[0];
  if (!pr) {
    res.status(404).json({ error: 'Payment request not found' });
    return null;
  }
  if (req.user.role === 'staff' && pr.branch_id !== req.user.branch_id) {
    res.status(403).json({ error: 'This payment request belongs to another branch' });
    return null;
  }
  return pr;
}

// ---------- GET /api/payments/lookup/:reference : reopen a request from a scanned reference ----------
router.get('/lookup/:reference', authenticate, async (req, res) => {
  const ref = req.params.reference;
  if (!REF_RE.test(ref)) return bad(res, 'Reference must be 24 hexadecimal characters');

  try {
    await expireStalePayments();
    const [rows] = await pool.execute(`SELECT ${COLUMNS} ${FROM_SQL} WHERE pr.reference_no = ?`, [ref.toUpperCase()]);
    const pr = rows[0];
    if (!pr) return res.status(404).json({ error: 'No payment request matches this reference' });
    if (req.user.role === 'staff' && pr.branch_id !== req.user.branch_id) {
      return res.status(403).json({ error: 'This payment request belongs to another branch' });
    }
    res.json({
      payment: {
        request_id: pr.request_id,
        reference_no: pr.reference_no,
        member_id: pr.member_id,
        member_name: pr.member_name,
        branch_id: pr.branch_id,
        branch_name: pr.branch_name,
        plan_name: pr.plan_name,
        request_type: pr.request_type,
        amount: pr.amount,
        method: pr.method,
        status: pr.status,
        requested_at: pr.requested_at,
        expires_at: pr.expires_at,
        verified_at: pr.verified_at,
      },
      detail_path: `/api/payments/${pr.request_id}`,
    });
  } catch (err) {
    serverError(res, 'Payment lookup error', err);
  }
});

// ---------- GET /api/payments/:id/qr?format=png|svg&download=1 ----------
router.get('/:id/qr', authenticate, async (req, res) => {
  try {
    const pr = await loadAuthorized(req, res);
    if (!pr) return;

    const format = req.query.format === undefined || req.query.format === '' ? 'png' : req.query.format;
    if (format !== 'png' && format !== 'svg') return bad(res, 'format must be png or svg');

    // The QR encodes ONLY the opaque reference number.
    let body;
    let type;
    if (format === 'svg') {
      body = await QRCode.toString(pr.reference_no, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
      type = 'image/svg+xml';
    } else {
      body = await QRCode.toBuffer(pr.reference_no, { type: 'png', ...QR_OPTIONS });
      type = 'image/png';
    }

    res.set({
      'Content-Type': type,
      'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="payment-${pr.request_id}-qr.${format}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    });
    res.send(body);
  } catch (err) {
    serverError(res, 'Payment QR error', err);
  }
});

// ---------- GET /api/payments/:id/summary : data for the printable transaction summary ----------
router.get('/:id/summary', authenticate, async (req, res) => {
  try {
    const pr = await loadAuthorized(req, res);
    if (!pr) return;

    const qrDataUrl = await QRCode.toDataURL(pr.reference_no, QR_OPTIONS);
    res.set('Cache-Control', 'private, no-store');
    res.json({
      summary: {
        request_id: pr.request_id,
        reference_no: pr.reference_no,
        member_id: pr.member_id,
        member_name: pr.member_name,
        branch_name: pr.branch_name,
        plan_name: pr.plan_name,
        request_type: pr.request_type,
        amount: pr.amount,
        method: pr.method,
        status: pr.status,
        requested_at: pr.requested_at,
        expires_at: pr.expires_at,
        verified_at: pr.verified_at,
        submitted_txn_masked: maskId(pr.submitted_txn_id),
        verification_txn_masked: maskId(pr.verification_txn_id),
        note: NOTES[pr.status] || '',
        qr_data_url: qrDataUrl,
      },
    });
  } catch (err) {
    serverError(res, 'Payment summary error', err);
  }
});

module.exports = router;