const pool = require('../config/db');

// Marks pending requests whose expiry time has passed as 'expired'. Safe to call repeatedly.
// Works with the pool or a transaction connection.
async function expireStalePayments(db = pool) {
  const [r] = await db.execute(
    "UPDATE payment_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW()"
  );
  return r.affectedRows;
}

module.exports = { expireStalePayments };