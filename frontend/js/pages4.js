// Reports, member history, and the member portal. Every value is inserted as text, never as HTML.

// ---------- Reports ----------
// Filter spec: [query name, label, type, options]. Types: text (default), date, number, select.
const REPORTS = {
  overdue: { title: 'Overdue loans', path: '/api/reports/overdue', filters: [
    ['member_name', 'Member name'], ['book', 'Title, author or ISBN'], ['min_days', 'Min days late', 'number']] },
  loans: { title: 'Loan history', path: '/api/reports/loans', filters: [
    ['member_name', 'Member name'], ['book', 'Title, author or ISBN'],
    ['status', 'Status', 'select', [['active', 'Active'], ['overdue', 'Overdue'], ['returned', 'Returned'], ['open', 'Open'], ['returned_late', 'Returned late'], ['returned_on_time', 'Returned on time']]],
    ['issued_from', 'Issued from', 'date'], ['issued_to', 'Issued to', 'date']] },
  'branch-activity': { title: 'Branch activity', path: '/api/reports/branch-activity', filters: [
    ['from', 'From', 'date'], ['to', 'To', 'date']] },
  inventory: { title: 'Branch inventory', path: '/api/reports/inventory', filters: [
    ['title', 'Title'], ['author', 'Author'], ['availability', 'Availability', 'select', [['available', 'Available'], ['unavailable', 'Unavailable']]]] },
  ebooks: { title: 'E-book catalogue', path: '/api/reports/ebooks', filters: [
    ['title', 'Title'], ['author', 'Author'], ['policy', 'Policy', 'select', [['read_only', 'Read only'], ['download_allowed', 'Download allowed'], ['staff_only', 'Staff only']]]] },
  'memberships-expiring': { title: 'Memberships expiring', path: '/api/reports/memberships-expiring', filters: [
    ['days', 'Within days (1-365)', 'number'], ['member_name', 'Member name']] },
  members: { title: 'Members by status', path: '/api/reports/members', filters: [
    ['member_name', 'Member name'],
    ['status', 'Status', 'select', [['active', 'Active'], ['inactive', 'Inactive'], ['suspended', 'Suspended'], ['restricted', 'Restricted']]],
    ['payment_status', 'Latest payment', 'select', [['pending', 'Pending'], ['successful', 'Successful'], ['rejected', 'Rejected'], ['expired', 'Expired'], ['none', 'None']]]] },
  payments: { title: 'Membership payments', path: '/api/reports/payments', filters: [
    ['member_name', 'Member name'],
    ['status', 'Status', 'select', [['pending', 'Pending'], ['successful', 'Successful'], ['rejected', 'Rejected'], ['expired', 'Expired']]],
    ['requested_from', 'Requested from', 'date'], ['requested_to', 'Requested to', 'date']] },
  'fine-payments': { title: 'Fine payments', path: '/api/reports/fine-payments', filters: [
    ['member_name', 'Member name'],
    ['status', 'Status', 'select', [['successful', 'Successful'], ['failed', 'Failed'], ['refunded', 'Refunded']]],
    ['paid_from', 'Paid from', 'date'], ['paid_to', 'Paid to', 'date']] },
  'fines-outstanding': { title: 'Outstanding fines', path: '/api/reports/fines-outstanding', filters: [
    ['member_name', 'Member name'], ['kind', 'Kind', 'select', [['finalized', 'Finalized'], ['estimate', 'Estimate (open loans)']]]] },
  incidents: { title: 'Incidents', path: '/api/reports/incidents', filters: [
    ['member_name', 'Member name'], ['type', 'Type', 'select', [['damage', 'Damage'], ['theft_concealment', 'Theft or concealment']]],
    ['status', 'Status', 'select', [['reported', 'Reported'], ['decided', 'Decided'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']]]] },
};

function reportsPanel() {
  const sel = h('select', { 'aria-label': 'Report' }, Object.entries(REPORTS).map(([k, r]) => h('option', { value: k }, r.title)));
  const filterBox = h('div', { class: 'row-form' });
  const msg = h('div');
  const out = h('div');
  let inputs = {};
  let page = 1;

  function buildFilters() {
    inputs = {};
    const spec = REPORTS[sel.value].filters;
    filterBox.replaceChildren(...spec.map(([name, lbl, type, opts]) => {
      const input = type === 'select'
        ? h('select', {}, h('option', { value: '' }, 'Any'), opts.map(([v, l]) => h('option', { value: v }, l)))
        : h('input', { type: type === 'date' ? 'date' : type === 'number' ? 'number' : 'text', maxlength: '100', min: type === 'number' ? '1' : false });
      inputs[name] = input;
      return h('label', { class: 'field' }, h('span', {}, lbl), input);
    }));
  }
  const params = () => {
    const p = {};
    for (const [k, el] of Object.entries(inputs)) if (el.value.trim() !== '') p[k] = el.value.trim();
    return p;
  };

  async function load() {
    out.replaceChildren(h('p', { class: 'hint' }, 'Loading...'));
    const rep = REPORTS[sel.value];
    const r = await api('GET', `${rep.path}?${new URLSearchParams({ ...params(), page: String(page) })}`);
    if (r.status !== 200) { out.replaceChildren(); say(msg, errorText(r), false); return; }
    msg.replaceChildren();
    const d = r.data;
    const rows = firstArray(d);
    const pages = Number(d.total_pages) || 1;
    const totals = d.totals ? Object.entries(d.totals).filter(([, v]) => v === null || typeof v !== 'object') : [];
    out.replaceChildren(
      h('p', { class: 'hint' }, `${d.total !== undefined ? d.total : rows.length} records${d.period ? `, ${d.period.from} to ${d.period.to}` : ''}. Generated ${cell(d.generated_at)}. The table shows the main columns; the CSV has all of them.`),
      totals.length ? h('div', { class: 'cards' }, totals.map(([k, v]) =>
        h('div', { class: 'stat' }, h('div', { class: 'num' }, cell(v)), h('div', { class: 'lbl' }, label(k))))) : null,
      dataTable(rows, pickKeys(rows, [], 12)),
      h('div', { class: 'pager' },
        h('button', { class: 'btn secondary small', type: 'button', disabled: page <= 1, on: { click: () => { page -= 1; load(); } } }, 'Previous'),
        h('span', {}, `Page ${page} of ${pages}`),
        h('button', { class: 'btn secondary small', type: 'button', disabled: page >= pages, on: { click: () => { page += 1; load(); } } }, 'Next')));
  }

  sel.addEventListener('change', () => { page = 1; buildFilters(); out.replaceChildren(); msg.replaceChildren(); });
  buildFilters();
  const form = h('form', { novalidate: true, on: { submit: (e) => { e.preventDefault(); page = 1; load(); } } },
    h('label', { class: 'field' }, h('span', {}, 'Report'), sel),
    filterBox,
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn small', type: 'submit' }, 'Run report'),
      h('button', { class: 'btn secondary small', type: 'button', on: { click: () => { buildFilters(); page = 1; out.replaceChildren(); msg.replaceChildren(); } } }, 'Clear filters'),
      h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
        const ok = await downloadCsv(REPORTS[sel.value].path, params());
        say(msg, ok ? 'CSV downloaded.' : 'CSV download failed. Check the filters.', ok);
      } } }, 'Download CSV')));
  return h('div', { class: 'panel wide' }, h('h2', {}, 'Reports'),
    h('p', { class: 'hint' }, 'Staff see their own branch; administrators see every branch.'), form, msg, out);
}

// ---------- Member history ----------
const HISTORY_SECTIONS = [['payments', 'Membership payments'], ['memberships', 'Memberships and renewals'], ['loans', 'Borrowing history'], ['restrictions', 'Suspensions and restrictions']];

function historyPanel() {
  const idInput = h('input', { type: 'number', min: '1', inputmode: 'numeric', required: true });
  const refInput = h('input', { type: 'text', maxlength: '24', placeholder: '24 characters' });
  const msg = h('div');
  const out = h('div');
  let memberId = null;
  const pages = {};

  async function load(id) {
    if (id !== memberId) HISTORY_SECTIONS.forEach(([k]) => { pages[k] = 1; });
    memberId = id;
    out.replaceChildren(h('p', { class: 'hint' }, 'Loading...'));
    const qs = new URLSearchParams(Object.fromEntries(HISTORY_SECTIONS.map(([k]) => [`${k}_page`, String(pages[k])])));
    const r = await api('GET', `/api/members/${id}/history?${qs}`);
    if (r.status !== 200) { out.replaceChildren(); say(msg, errorText(r), false); return; }
    msg.replaceChildren();
    const d = r.data;
    out.replaceChildren(
      h('h3', {}, `${d.member.full_name} (member ${d.member.member_id})`),
      h('p', { class: 'hint' }, `${d.member.branch_name}, status ${d.member.status}, registered ${cell(d.member.registered_on)}. Generated ${cell(d.generated_at)}.`),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
          const ok = await downloadCsv(`/api/members/${id}/history`, {});
          say(msg, ok ? 'CSV downloaded.' : 'CSV download failed.', ok);
        } } }, 'Download CSV'),
        h('button', { class: 'btn secondary small', type: 'button', on: { click: () => openPrint(id) } }, 'Printable page with QR')),
      h('div', { class: 'cards' }, Object.entries(d.summary).map(([k, v]) =>
        h('div', { class: 'stat' }, h('div', { class: 'num' }, cell(v)), h('div', { class: 'lbl' }, label(k))))),
      HISTORY_SECTIONS.map(([key, title]) => {
        const s = d[key];
        return h('div', {},
          h('h3', {}, `${title} (${s.total})`),
          dataTable(s.data, pickKeys(s.data, [], 11)),
          s.total_pages > 1 ? h('div', { class: 'pager' },
            h('button', { class: 'btn secondary small', type: 'button', disabled: s.page <= 1, on: { click: () => { pages[key] = s.page - 1; load(id); } } }, 'Previous'),
            h('span', {}, `Page ${s.page} of ${s.total_pages}`),
            h('button', { class: 'btn secondary small', type: 'button', disabled: s.page >= s.total_pages, on: { click: () => { pages[key] = s.page + 1; load(id); } } }, 'Next')) : null);
      }));
  }

  // The print endpoint needs the sign-in token, so it is fetched and shown as a local page.
  async function openPrint(id) {
    const w = window.open('', '_blank');
    if (!w) { say(msg, 'The browser blocked the new window. Allow pop-ups for this site and try again.', false); return; }
    const res = await fetch(`/api/members/${id}/history/print`, { headers: { Authorization: `Bearer ${Session.token}` } });
    if (!res.ok) { w.close(); say(msg, 'Could not open the printable page.', false); return; }
    const html = await res.text();
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    w.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  const form = h('form', { class: 'row-form', novalidate: true, on: { submit: (e) => {
    e.preventDefault();
    const id = parseInt(idInput.value, 10);
    if (!id || id < 1) { say(msg, 'Enter a valid member ID.', false); return; }
    load(id);
  } } },
  h('label', { class: 'field' }, h('span', {}, 'Member ID'), idInput),
  h('button', { class: 'btn', type: 'submit' }, 'Show history'));

  const refForm = h('form', { class: 'row-form', novalidate: true, on: { submit: async (e) => {
    e.preventDefault();
    const code = refInput.value.trim();
    if (!/^[0-9A-Fa-f]{24}$/.test(code)) { say(msg, 'A report reference is 24 letters and digits (0-9, A-F).', false); return; }
    const r = await api('GET', `/api/member-history/ref/${code}`);
    if (r.status !== 200) { say(msg, errorText(r), false); return; }
    const ref = r.data.reference;
    say(msg, `Reference belongs to ${ref.member_name} (member ${ref.member_id}), generated ${cell(ref.generated_at)} by ${ref.generated_by_name}.`, true);
    idInput.value = String(ref.member_id);
    load(ref.member_id);
  } } },
  h('label', { class: 'field' }, h('span', {}, 'Scanned report reference'), refInput),
  h('button', { class: 'btn secondary', type: 'submit' }, 'Look up reference'));

  return h('div', { class: 'panel wide' }, h('h2', {}, 'Member history'),
    h('p', { class: 'hint' }, 'Payments, memberships, loans, fines, suspensions and restrictions for one member. Each CSV or printed page gets a new report reference.'),
    form, refForm, msg, out);
}

PageRenderers.reports = async (box) => {
  box.append(reportsPanel(), h('div', { class: 'gap' }), historyPanel());
};

// ---------- Member portal ----------
PageRenderers['my-loans'] = async (box) => {
  const sumBox = h('div');
  const wrap = h('div', { class: 'nocsv' });
  box.append(wrap);
  listPage(wrap, {
    title: 'My loans',
    path: '/api/me/loans',
    searchFields: [['status', 'Status (active, overdue, returned)']],
    preferred: ['loan_id', 'title', 'author', 'branch_name', 'issue_date', 'due_date', 'return_date', 'loan_status', 'overdue_days', 'fine_kind', 'fine_amount', 'fine_paid', 'fine_balance'],
    above: sumBox,
  });
  const r = await api('GET', '/api/me/loans');
  if (r.status === 200 && r.data.summary) {
    sumBox.replaceChildren(h('div', { class: 'cards' }, Object.entries(r.data.summary).map(([k, v]) =>
      h('div', { class: 'stat' }, h('div', { class: 'num' }, cell(v)), h('div', { class: 'lbl' }, label(k))))),
    h('p', { class: 'hint' }, 'An estimated fine belongs to a book you have not returned yet and keeps growing until it is returned.'));
  }
};

PageRenderers['my-catalogue'] = async (box) => {
  const wrap = h('div', { class: 'nocsv' });
  box.append(wrap);
  listPage(wrap, {
    title: 'Catalogue',
    path: '/api/me/books',
    searchFields: [['search', 'Title, author or category'], ['title', 'Title'], ['author', 'Author'], ['category', 'Category']],
    preferred: ['book_id', 'title', 'author', 'category', 'edition', 'branch_name', 'available_copies', 'total_copies'],
  });
};

PageRenderers['my-profile'] = async (box) => {
  box.append(h('p', { class: 'hint' }, 'Loading...'));
  const [me, ms] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/me/memberships')]);
  if (me.status !== 200) { box.replaceChildren(h('p', { class: 'msg' }, errorText(me))); return; }
  const m = me.data.member || {};
  const cur = me.data.current_membership;
  const facts = Object.entries(m).filter(([, v]) => v === null || typeof v !== 'object');
  const payWrap = h('div', { class: 'notoolbar' });
  box.replaceChildren(
    h('div', { class: 'panel wide' }, h('h2', {}, 'My profile'),
      me.data.suspension_ends ? h('p', { class: 'msg' }, `Your borrowing is suspended until ${me.data.suspension_ends}.`) : null,
      h('dl', {}, facts.map(([k, v]) => [h('dt', {}, label(k)), h('dd', {}, cell(v))])),
      h('h3', {}, 'Current membership'),
      cur ? h('dl', {}, Object.entries(cur).map(([k, v]) => [h('dt', {}, label(k)), h('dd', {}, cell(v))]))
        : h('p', { class: 'hint' }, 'You have no active membership. Ask the library staff to renew it.'),
      h('h3', {}, 'Membership history'),
      ms.status === 200 ? dataTable(ms.data.data, pickKeys(ms.data.data, ['plan_name', 'start_date', 'expiry_date', 'duration_months', 'fee_paid', 'is_current'])) : h('p', { class: 'msg' }, errorText(ms))),
    payWrap);
  listPage(payWrap, {
    title: 'My membership payments',
    path: '/api/me/payments',
    preferred: ['request_id', 'request_type', 'plan_name', 'amount', 'method', 'status', 'requested_at', 'expires_at', 'verified_at', 'rejection_reason'],
  });
};