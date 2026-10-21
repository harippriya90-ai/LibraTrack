// Payments and Loans pages. Every value is inserted as text, never as HTML.

async function loadPlans() {
  const r = await api('GET', '/api/plans');
  return r.status === 200 ? firstArray(r.data) : [];
}

// ---------- Payments ----------
PageRenderers.payments = async (box, ctx) => {
  const plans = await loadPlans();
  const member = h('input', { type: 'number', min: '1', required: true, inputmode: 'numeric' });
  const plan = h('select', { required: true }, h('option', { value: '' }, 'Choose plan'),
    plans.map((p) => h('option', { value: p.plan_id }, p.plan_name || p.name || `Plan ${p.plan_id}`)));
  const method = h('select', { required: true },
    h('option', { value: 'upi' }, 'UPI'), h('option', { value: 'cash' }, 'Cash'));
  const addMsg = h('div');
  let listApi = null;

  const addForm = h('form', { class: 'row-form', novalidate: true, on: { submit: async (e) => {
    e.preventDefault();
    const body = { member_id: Number(member.value), plan_id: Number(plan.value), method: method.value };
    const r = await api('POST', '/api/payments', body);
    if (r.status === 201) {
      say(addMsg, 'Payment request created. It stays pending until verified.', true);
      addForm.reset();
      listApi.reload();
    } else say(addMsg, errorText(r) + fieldErrors(r), false);
  } } },
  h('label', { class: 'field' }, h('span', {}, 'Member ID'), member),
  h('label', { class: 'field' }, h('span', {}, 'Plan'), plan),
  h('label', { class: 'field' }, h('span', {}, 'Method'), method),
  h('button', { class: 'btn', type: 'submit' }, 'Create request'));

  listApi = listPage(box, {
    title: 'Payments',
    path: '/api/payments',
    searchFields: [['search', 'Member, plan or reference']],
    preferred: ['request_id', 'member_name', 'plan_name', 'branch_name', 'amount', 'method', 'status', 'requested_at', 'expires_at', 'verification_txn_id'],
    above: h('div', {}, h('h3', {}, 'New payment request'), addForm, addMsg),
    actions: (row, reload, msg) => {
      if (row.status !== 'pending') return [];
      return [
        h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
          const v = window.prompt(`Transaction ID to verify request ${row.request_id}`, '');
          if (v === null) return;
          const r = await api('POST', `/api/payments/${row.request_id}/verify`, { verification_txn_id: v.trim() });
          say(msg, r.status === 200 ? 'Payment verified. Membership activated.' : errorText(r) + fieldErrors(r), r.status === 200);
          if (r.status === 200) reload();
        } } }, 'Verify'),
        h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
          const v = window.prompt(`Reason for rejecting request ${row.request_id}`, '');
          if (v === null) return;
          const r = await api('POST', `/api/payments/${row.request_id}/reject`, { reason: v.trim() });
          say(msg, r.status === 200 ? 'Payment request rejected.' : errorText(r) + fieldErrors(r), r.status === 200);
          if (r.status === 200) reload();
        } } }, 'Reject'),
      ];
    },
  });
};

// ---------- Loans ----------
PageRenderers.loans = async (box, ctx) => {
  const branches = await loadBranches(ctx);
  const member = h('input', { type: 'number', min: '1', required: true, inputmode: 'numeric' });
  const book = h('input', { type: 'number', min: '1', required: true, inputmode: 'numeric' });
  const br = ctx.role === 'admin' ? branchSelect(branches) : null;
  const addMsg = h('div');
  let listApi = null;

  const addForm = h('form', { class: 'row-form', novalidate: true, on: { submit: async (e) => {
    e.preventDefault();
    const body = { member_id: Number(member.value), book_id: Number(book.value) };
    if (br) body.branch_id = Number(br.value);
    const r = await api('POST', '/api/loans', body);
    if (r.status === 201) {
      const l = r.data && r.data.loan;
      say(addMsg, l && l.due_date ? `Book issued. Due on ${l.due_date}.` : 'Book issued.', true);
      addForm.reset();
      listApi.reload();
    } else say(addMsg, errorText(r) + fieldErrors(r), false);
  } } },
  h('label', { class: 'field' }, h('span', {}, 'Member ID'), member),
  h('label', { class: 'field' }, h('span', {}, 'Book ID'), book),
  br ? h('label', { class: 'field' }, h('span', {}, 'Branch'), br) : null,
  h('button', { class: 'btn', type: 'submit' }, 'Issue book'));

  listApi = listPage(box, {
    title: 'Loans',
    path: '/api/loans',
    searchFields: [['search', 'Member or book']],
    preferred: ['loan_id', 'member_name', 'book_title', 'branch_name', 'issue_date', 'due_date', 'return_date', 'loan_status', 'overdue_days', 'fine_amount', 'fine_paid'],
    above: h('div', {}, h('h3', {}, 'Issue a book'), addForm, addMsg),
    actions: (row, reload, msg) => {
      if (row.return_date) return [];
      return [h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
        if (!window.confirm(`Mark loan ${row.loan_id} as returned?`)) return;
        const r = await api('POST', `/api/loans/${row.loan_id}/return`);
        say(msg, r.status === 200 ? 'Book returned.' : errorText(r), r.status === 200);
        if (r.status === 200) reload();
      } } }, 'Return')];
    },
  });
};