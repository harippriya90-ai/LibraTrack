const pool = require('../config/db');

// One place that decides whether a member may use restricted resources (ebooks now, more later).
// "active" in v_member_status already means: account on, a membership covering today
// (memberships exist only after a verified payment), not suspended, not restricted.
async function getMemberAccess(memberId) {
  const [rows] = await pool.execute(
    `SELECT vs.effective_status AS status,
            (SELECT MAX(r.end_date) FROM member_restrictions r
              WHERE r.member_id = vs.member_id AND r.kind = 'suspension' AND r.revoked_at IS NULL
                AND CURDATE() BETWEEN r.start_date AND r.end_date) AS suspension_ends
       FROM v_member_status vs
      WHERE vs.member_id = ?`,
    [memberId]
  );
  const r = rows[0];
  if (!r) return { eligible: false, status: 'unknown', reason: 'Member not found.' };
  if (r.status === 'active') return { eligible: true, status: 'active', reason: null };

  const reasons = {
    restricted: 'Your account is restricted. Please contact the library.',
    suspended: `Your account is suspended until ${r.suspension_ends}.`,
    inactive: 'Your membership is not active or has expired.',
  };
  return { eligible: false, status: r.status, reason: reasons[r.status] || 'Access is not available.' };
}

module.exports = { getMemberAccess };