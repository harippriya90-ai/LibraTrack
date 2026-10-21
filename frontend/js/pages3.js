// Fines and Incidents pages. Every value is inserted as text, never as HTML.

const FINE_METHODS = [['upi', 'UPI'], ['cash', 'Cash'], ['card', 'Card'], ['netbanking', 'Net banking'], ['bank_transfer', 'Bank transfer']];
const ALLOWED_DECISIONS = {
  damage: [['replace_and_suspend', 'Replace book and suspend member'], ['no_action', 'No action']],
  theft_concealment: [['permanent_restriction', 'Permanent restriction'], ['no_action', 'No action']],
};
const textArea = (attrs = {}) => h('textarea', { rows: '3', maxlength: '2000', ...attrs });

// ---------- Fines (one loan at a time) ----------
PageRenderers.fines = async (box, ctx) => {
  const isAdmin = ctx.role === 'admin';
  const loanInput = h('input', { type: 'number', min: '1', required: true, inputmode: 'numeric', 'aria-label': 'Loan ID' });
  const msg = h('div');
  const out = h('div');
  let currentLoan = null;

  async function show(id) {
    currentLoan = id;
    out.replaceChildren(h('p', { class: 'hint' }, 'Loading...'));
    const r = await api('GET', `/api/loans/${id}/fine`);
    if (r.status !== 200) { out.replaceChildren(); say(msg, errorText(r), false); return; }
    msg.replaceChildren();
    const f = r.data.fine;
    const stats = [['Status', f.payment_status], ['Overdue days', f.overdue_days], ['Rate per day', f.fine_rate],
      ['Total fine', f.total_fine], ['Paid', f.amount_paid], ['Balance', f.balance]];

    const amount = h('input', { type: 'text', inputmode: 'decimal', maxlength: '12', required: true, value: f.balance });
    const method = h('select', { required: true }, FINE_METHODS.map(([k, l]) => h('option', { value: k }, l)));
    const ref = h('input', { type: 'text', maxlength: '60' });
    const payMsg = h('div');
    const payForm = f.can_accept_payment ? h('form', { class: 'row-form', novalidate: true, on: { submit: async (e) => {
      e.preventDefault();
      const body = { amount: amount.value.trim(), method: method.value };
      if (ref.value.trim()) body.transaction_ref = ref.value.trim();
      const pr = await api('POST', `/api/loans/${id}/fine-payments`, body);
      if (pr.status === 201) { await show(id); say(msg, 'Payment recorded.', true); } else say(payMsg, errorText(pr) + fieldErrors(pr), false);
    } } },
    h('label', { class: 'field' }, h('span', {}, 'Amount (INR)'), amount),
    h('label', { class: 'field' }, h('span', {}, 'Method'), method),
    h('label', { class: 'field' }, h('span', {}, 'Transaction reference (not needed for cash)'), ref),
    h('button', { class: 'btn', type: 'submit' }, 'Record payment')) : null;

    const waiveBtn = isAdmin && f.fine_kind === 'finalized' ? h('button', { class: 'btn secondary', type: 'button', on: { click: async () => {
      const v = window.prompt(f.waived ? 'Reason for restoring the fine (optional)' : 'Reason for waiving this fine (3 to 255 characters)', '');
      if (v === null) return;
      const wr = await api('PATCH', `/api/loans/${id}/fine`, { waived: !f.waived, reason: v.trim() });
      if (wr.status === 200) { await show(id); say(msg, f.waived ? 'Waiver removed.' : 'Fine waived.', true); } else say(msg, errorText(wr) + fieldErrors(wr), false);
    } } }, f.waived ? 'Restore fine' : 'Waive fine') : null;

    const refundAction = isAdmin ? (row) => (row.status === 'successful' ? [h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
      const v = window.prompt(`Reason for refunding payment ${row.fine_payment_id} (3 to 255 characters)`, '');
      if (v === null) return;
      const rr = await api('POST', `/api/fine-payments/${row.fine_payment_id}/refund`, { reason: v.trim() });
      if (rr.status === 200) { await show(id); say(msg, 'Payment refunded.', true); } else say(msg, errorText(rr) + fieldErrors(rr), false);
    } } }, 'Refund')] : []) : null;

    out.replaceChildren(
      h('h3', {}, `Loan ${f.loan_id}`),
      f.fine_kind !== 'finalized' ? h('p', { class: 'hint' }, 'The book is not returned yet, so this is a live estimate. Payments open after the return.') : null,
      f.waived ? h('p', { class: 'msg ok' }, 'This fine was waived.') : null,
      h('div', { class: 'cards' }, stats.map(([l, v]) => h('div', { class: 'stat' }, h('div', { class: 'num' }, cell(v)), h('div', { class: 'lbl' }, l)))),
      payForm, payMsg, waiveBtn,
      h('h3', {}, 'Payments'),
      dataTable(r.data.payments, ['fine_payment_id', 'amount', 'method', 'transaction_ref_masked', 'status', 'paid_at', 'recorded_by_name'], refundAction));
  }

  const lookup = h('form', { class: 'row-form', novalidate: true, on: { submit: (e) => {
    e.preventDefault();
    const id = parseInt(loanInput.value, 10);
    if (!id || id < 1) { say(msg, 'Enter a valid loan ID.', false); return; }
    show(id);
  } } },
  h('label', { class: 'field' }, h('span', {}, 'Loan ID'), loanInput),
  h('button', { class: 'btn', type: 'submit' }, 'Look up fine'),
  h('button', { class: 'btn secondary', type: 'button', on: { click: () => { if (currentLoan) show(currentLoan); } } }, 'Refresh'));

  box.append(h('div', { class: 'panel wide' }, h('h2', {}, 'Fines'),
    h('p', { class: 'hint' }, 'Find the Loan ID on the Loans page. A fine becomes final when the book is returned.'),
    lookup, msg, out));
};

// ---------- Incidents ----------
PageRenderers.incidents = async (box, ctx) => {
  const isAdmin = ctx.role === 'admin';
  const loan = h('input', { type: 'number', min: '1', required: true, inputmode: 'numeric' });
  const type = h('select', { required: true },
    h('option', { value: 'damage' }, 'Damage'), h('option', { value: 'theft_concealment' }, 'Theft or concealment'));
  const desc = textArea({ required: true, minlength: '10' });
  const addMsg = h('div');
  const decideBox = h('div');
  let listApi = null;

  const reportForm = h('form', { class: 'row-form', novalidate: true, on: { submit: async (e) => {
    e.preventDefault();
    const r = await api('POST', '/api/incidents', { loan_id: Number(loan.value), incident_type: type.value, description: desc.value.trim() });
    if (r.status === 201) {
      say(addMsg, `Incident ${r.data.incident.incident_ref} reported. An administrator will review it.`, true);
      reportForm.reset();
      listApi.reload();
    } else say(addMsg, errorText(r) + fieldErrors(r), false);
  } } },
  h('label', { class: 'field' }, h('span', {}, 'Loan ID'), loan),
  h('label', { class: 'field' }, h('span', {}, 'Type'), type),
  h('label', { class: 'field' }, h('span', {}, 'What happened (10 characters or more)'), desc),
  h('button', { class: 'btn', type: 'submit' }, 'Report incident'));

  function openDecide(row, reload) {
    const opts = ALLOWED_DECISIONS[row.incident_type] || [];
    const dec = h('select', { required: true }, opts.map(([k, l]) => h('option', { value: k }, l)));
    const notes = textArea({ required: true });
    const m = h('div');
    decideBox.replaceChildren(h('form', { class: 'row-form', novalidate: true, on: { submit: async (e) => {
      e.preventDefault();
      const r = await api('POST', `/api/incidents/${row.incident_id}/decide`, { decision: dec.value, notes: notes.value.trim() });
      if (r.status === 200) { decideBox.replaceChildren(); say(addMsg, `Decision recorded for ${row.incident_ref}.`, true); reload(); } else say(m, errorText(r) + fieldErrors(r), false);
    } } },
    h('strong', {}, `Decide ${row.incident_ref}`),
    h('label', { class: 'field' }, h('span', {}, 'Decision'), dec),
    h('label', { class: 'field' }, h('span', {}, 'Reasons (10+ characters; 20+ for a permanent restriction)'), notes),
    h('button', { class: 'btn', type: 'submit' }, 'Save decision'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => decideBox.replaceChildren() } }, 'Cancel'), m));
  }

  // Suspension and restriction history for one member, with Lift for active ones.
  const rMember = h('input', { type: 'number', min: '1', required: true, inputmode: 'numeric' });
  const rOut = h('div');
  const rMsg = h('div');
  async function loadRestrictions(id) {
    const r = await api('GET', `/api/members/${id}/restrictions`);
    if (r.status !== 200) { rOut.replaceChildren(); say(rMsg, errorText(r), false); return; }
    rMsg.replaceChildren();
    rOut.replaceChildren(dataTable(r.data.data,
      ['restriction_id', 'kind', 'start_date', 'end_date', 'reason', 'incident_ref', 'is_active_now', 'revoked_at'],
      isAdmin ? (row) => (row.is_active_now ? [h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
        const v = window.prompt('Reason for lifting this restriction (10 to 255 characters)', '');
        if (v === null) return;
        const rr = await api('POST', `/api/restrictions/${row.restriction_id}/revoke`, { reason: v.trim() });
        if (rr.status === 200) { say(rMsg, 'Restriction lifted.', true); loadRestrictions(id); } else say(rMsg, errorText(rr) + fieldErrors(rr), false);
      } } }, 'Lift')] : []) : null));
  }
  const rForm = h('form', { class: 'row-form', novalidate: true, on: { submit: (e) => {
    e.preventDefault();
    const id = parseInt(rMember.value, 10);
    if (!id || id < 1) { say(rMsg, 'Enter a valid member ID.', false); return; }
    loadRestrictions(id);
  } } },
  h('label', { class: 'field' }, h('span', {}, 'Member ID'), rMember),
  h('button', { class: 'btn secondary', type: 'submit' }, 'Show restrictions'));

  listApi = listPage(box, {
    title: 'Incidents',
    path: '/api/incidents',
        searchFields: [['incident_id', 'Incident ID'], ['member_id', 'Member ID'], ['loan_id', 'Loan ID'], ['status', 'Status (reported, decided, resolved, dismissed)'], ['type', 'Type (damage, theft_concealment)']],
    preferred: ['incident_id', 'incident_ref', 'incident_type', 'status', 'decision', 'member_id', 'member_name', 'loan_id', 'book_title', 'branch_name', 'reported_at', 'reported_by_name'],
    above: h('div', {},
      h('h3', {}, 'Report an incident'), reportForm, addMsg, decideBox,
      h('h3', {}, 'Member restrictions'), rForm, rMsg, rOut),
    actions: (row, reload, msg) => {
      if (!isAdmin) return [];
      const acts = [];
      if (row.status === 'reported') {
        acts.push(h('button', { class: 'btn secondary small', type: 'button', on: { click: () => openDecide(row, reload) } }, 'Decide'));
      }
      if (row.status === 'decided' && row.decision === 'replace_and_suspend') {
        acts.push(h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
          const v = window.prompt(`Describe the replacement received for ${row.incident_ref} (10 to 1000 characters)`, '');
          if (v === null) return;
          const r = await api('POST', `/api/incidents/${row.incident_id}/resolve`, { notes: v.trim() });
          say(msg, r.status === 200 ? 'Incident resolved.' : errorText(r) + fieldErrors(r), r.status === 200);
          if (r.status === 200) reload();
        } } }, 'Replacement received'));
      }
      return acts;
    },
  });
};