const pool = require('../config/db');

// An error that carries an HTTP status and a safe message for the client.
class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

// Runs fn(conn) inside one transaction: commits if it finishes, rolls back if it throws.
// options.isolation may be 'READ COMMITTED' so reads inside the transaction always see the
// latest committed rows (used by loan issuing together with row locks).
async function withTransaction(fn, options = {}) {
  const conn = await pool.getConnection();
  try {
    if (options.isolation === 'READ COMMITTED') {
      // Applies to the next transaction on this connection only.
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    }
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    conn.release();
  }
}

// Works with the pool or a transaction connection, so the audit row commits with the change.
async function logAudit(db, userId, action, entityType, entityId, details) {
  await db.execute(
    'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)',
    [
      userId,
      action,
      entityType,
      entityId === null || entityId === undefined ? null : String(entityId),
      details ? String(details).slice(0, 500) : null,
    ]
  );
}

module.exports = { HttpError, withTransaction, logAudit };