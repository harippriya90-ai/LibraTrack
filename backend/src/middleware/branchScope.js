// Decides which branch(es) a request may touch, from the verified user only.
function branchScope(req, res, next) {
  if (req.user.role === 'admin') {
    // Admin may optionally narrow to one branch. This is a filter, not a permission.
    let filter = null;
    const raw = req.query.branch_id;
    if (raw !== undefined && raw !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: 'branch_id must be a positive whole number' });
      }
      filter = n;
    }
    req.scope = { all: true, branchId: filter };
    return next();
  }

  if (req.user.role === 'staff' && req.user.branch_id) {
    // Staff are pinned to their own branch. Any branch_id in the request is ignored.
    req.scope = { all: false, branchId: req.user.branch_id };
    return next();
  }

  return res.status(403).json({ error: 'You do not have permission to do this' });
}

// Returns a SQL fragment + params. `column` must be a literal from our own code, never user input.
function scopeCondition(req, column) {
  if (req.scope.branchId) {
    return { sql: `${column} = ?`, params: [req.scope.branchId] };
  }
  return { sql: '1 = 1', params: [] };
}

module.exports = { branchScope, scopeCondition };