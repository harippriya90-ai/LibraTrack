// Dashboard, Books and Members pages. Every value is inserted as text, never as HTML.
const PageRenderers = {};

// ---------- helpers ----------
const firstArray = (d) => {
  if (Array.isArray(d)) return d;
  for (const v of Object.values(d || {})) if (Array.isArray(v)) return v;
  return [];
};
const label = (k) => String(k).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function pickKeys(rows, preferred, max = 9) {
  const have = rows.length ? Object.keys(rows[0]) : [];
  const keys = preferred.filter((k) => have.includes(k));
  return keys.length ? keys : have.slice(0, max);
}
function fieldErrors(r) {
  const f = r.data && r.data.fields;
  return f ? ` (${Object.entries(f).map(([k, v]) => `${label(k)}: ${v}`).join('; ')})` : '';
}
function say(msgBox, text, ok) {
  msgBox.replaceChildren(h('p', { class: ok ? 'msg ok' : 'msg', role: 'alert' }, text));
}
function dataTable(rows, keys, actions) {
  if (!rows.length) return h('p', { class: 'hint' }, 'No records found.');
  const head = h('tr', {}, keys.map((k) => h('th', {}, label(k))), actions ? h('th', {}, 'Actions') : null);
  const body = rows.map((row) => h('tr', {},
    keys.map((k) => h('td', {}, cell(row[k]))),
    actions ? h('td', { class: 'acts' }, actions(row)) : null));
  return h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', {}, head), h('tbody', {}, body)));
}
async function downloadCsv(path, params) {
  const qs = new URLSearchParams({ ...params, format: 'csv' });
  const res = await fetch(`${path}?${qs}`, { headers: { Authorization: `Bearer ${Session.token}` } });
  if (!res.ok) return false;
  const blob = await res.blob();
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  const a = h('a', { href: URL.createObjectURL(blob), download: m ? m[1] : 'export.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}
async function loadBranches(ctx) {
  if (ctx.role !== 'admin') return [];
  const r = await api('GET', '/api/branches');
  return r.status === 200 ? firstArray(r.data) : [];
}
function branchSelect(branches) {
  return h('select', { required: true }, h('option', { value: '' }, 'Choose branch'),
    branches.map((b) => h('option', { value: b.branch_id }, b.name)));
}
const textField = (name, lbl, attrs = {}) => {
  const input = h('input', { name, type: 'text', maxlength: '120', ...attrs });
  return { input, node: h('label', { class: 'field' }, h('span', {}, lbl), input) };
};

// ---------- a reusable searchable, paged list ----------
function listPage(box, cfg) {
  const fields = cfg.searchFields || [['search', 'All']];
  const state = { page: 1, search: '', field: fields[0][0] };
  const msg = h('div');
  const out = h('div');
  const searchInput = h('input', { type: 'search', placeholder: 'Type to search', maxlength: '100', 'aria-label': 'Search' });
  const fieldSel = h('select', { 'aria-label': 'Search by', on: { change: (e) => { state.field = e.target.value; } } },
    fields.map(([k, lbl]) => h('option', { value: k }, lbl)));

  const searchParams = () => (state.search ? { [state.field]: state.search } : {});

  async function load() {
    out.replaceChildren(h('p', { class: 'hint' }, 'Loading...'));
    const params = { page: String(state.page), ...searchParams() };
    const r = await api('GET', `${cfg.path}?${new URLSearchParams(params)}`);
    if (r.status !== 200) { out.replaceChildren(h('p', { class: 'msg' }, errorText(r))); return; }
    const rows = firstArray(r.data);
    const d = r.data || {};
    const total = d.total !== undefined ? Number(d.total) : rows.length;
    const size = Number(d.page_size) || 10;
    const pages = Number(d.total_pages) || Math.max(1, Math.ceil(total / size));
    if (state.page > pages) { state.page = pages; load(); return; }

    const go = (p) => { state.page = Math.min(pages, Math.max(1, p)); load(); };
    const jump = h('input', { type: 'number', min: '1', max: String(pages), value: String(state.page), 'aria-label': 'Go to page', class: 'jump' });
    const first = state.page <= 1;
    const last = state.page >= pages;
    const byLabel = (fields.find(([k]) => k === state.field) || [])[1];

    out.replaceChildren(
      h('p', { class: 'hint' }, `${total} records${state.search ? ` where ${byLabel} contains "${state.search}"` : ''}`),
      dataTable(rows, pickKeys(rows, cfg.preferred), cfg.actions ? (row) => cfg.actions(row, load, msg) : null),
      h('div', { class: 'pager' },
        h('button', { class: 'btn secondary small', type: 'button', disabled: first, on: { click: () => go(1) } }, 'First'),
        h('button', { class: 'btn secondary small', type: 'button', disabled: first, on: { click: () => go(state.page - 1) } }, 'Previous'),
        h('span', {}, `Page ${state.page} of ${pages}`),
        h('button', { class: 'btn secondary small', type: 'button', disabled: last, on: { click: () => go(state.page + 1) } }, 'Next'),
        h('button', { class: 'btn secondary small', type: 'button', disabled: last, on: { click: () => go(pages) } }, 'Last'),
        h('form', { class: 'jumpform', on: { submit: (e) => { e.preventDefault(); go(parseInt(jump.value, 10) || 1); } } },
          jump, h('button', { class: 'btn secondary small', type: 'submit' }, 'Go'))));
  }

  const doSearch = () => { state.search = searchInput.value.trim(); state.page = 1; load(); };
  const toolbar = h('form', { class: 'toolbar', on: { submit: (e) => { e.preventDefault(); doSearch(); } } },
    fieldSel,
    searchInput,
    h('button', { class: 'btn small', type: 'submit' }, 'Search'),
    h('button', { class: 'btn secondary small', type: 'button', on: { click: () => { searchInput.value = ''; state.search = ''; state.page = 1; load(); } } }, 'Clear'),
    h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
      const ok = await downloadCsv(cfg.path, searchParams());
      say(msg, ok ? 'CSV downloaded.' : 'CSV download is not available for this list.', ok);
    } } }, 'Download CSV'));

  box.append(h('div', { class: 'panel wide' }, h('h2', {}, cfg.title), cfg.above || null, msg, toolbar, out));
  load();
  return { reload: load, msg };
}

// ---------- Dashboard ----------
function renderAny(value, title, depth) {
  const wrap = h('section', { class: 'dash' });
  if (title) wrap.append(h(depth === 0 ? 'h2' : 'h3', {}, label(title)));
  const scalars = [];
  const rest = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === null || typeof v !== 'object') scalars.push([k, v]);
    else rest.push([k, v]);
  }
  if (scalars.length) {
    wrap.append(h('div', { class: 'cards' }, scalars.map(([k, v]) =>
      h('div', { class: 'stat' }, h('div', { class: 'num' }, cell(v)), h('div', { class: 'lbl' }, label(k))))));
  }
  for (const [k, v] of rest) {
    if (Array.isArray(v)) {
      const objs = v.every((x) => x && typeof x === 'object' && !Array.isArray(x));
      wrap.append(h('h3', {}, label(k)), objs ? dataTable(v, pickKeys(v, [], 8)) : h('p', {}, v.map(cell).join(', ') || 'None'));
    } else if (depth < 3) {
      wrap.append(renderAny(v, k, depth + 1));
    }
  }
  return wrap;
}
PageRenderers.dashboard = async (box) => {
  box.append(h('p', { class: 'hint' }, 'Loading...'));
  const r = await api('GET', '/api/dashboard');
  if (r.status !== 200) { box.replaceChildren(h('p', { class: 'msg' }, errorText(r))); return; }
  box.replaceChildren(h('div', { class: 'panel wide' }, h('h2', {}, 'Dashboard'),
    renderAny(r.data || {}, null, 0),
    h('p', { class: 'hint' }, 'Figures are live from the server and follow your branch.')));
};

// ---------- Books ----------
PageRenderers.books = async (box, ctx) => {
  const branches = await loadBranches(ctx);
  const t = textField('title', 'Title', { required: true });
  const a = textField('author', 'Author', { required: true });
  const c = textField('category', 'Category', { required: true });
  const p = textField('price', 'Price (INR)', { inputmode: 'decimal', maxlength: '12', required: true });
  const f = textField('fine_per_day', 'Fine per day (INR)', { inputmode: 'decimal', maxlength: '10' });
  const addMsg = h('div');
  let listApi = null;

  const addForm = h('form', { class: 'row-form', novalidate: true, on: { submit: async (e) => {
    e.preventDefault();
    const body = { title: t.input.value.trim(), author: a.input.value.trim(), category: c.input.value.trim(), price: Number(p.input.value) };
    if (f.input.value.trim() !== '') body.fine_per_day = Number(f.input.value);
    const r = await api('POST', '/api/books', body);
    if (r.status === 201) {
      say(addMsg, 'Book added. Set its stock with the Stock button.', true);
      addForm.reset();
      listApi.reload();
    } else say(addMsg, errorText(r) + fieldErrors(r), false);
  } } }, t.node, a.node, c.node, p.node, f.node, h('button', { class: 'btn', type: 'submit' }, 'Add book'));

  // Inline stock editor, opened from a row.
  const stockBox = h('div');
  function openStock(row, reload) {
    const copies = h('input', { type: 'number', min: '0', max: '9999', required: true, value: '1' });
    const br = ctx.role === 'admin' ? branchSelect(branches) : null;
    const m = h('div');
    stockBox.replaceChildren(h('form', { class: 'row-form', on: { submit: async (e) => {
      e.preventDefault();
      const body = { total_copies: Number(copies.value) };
      if (br) body.branch_id = Number(br.value);
      const r = await api('PUT', `/api/books/${row.book_id}/inventory`, body);
      if (r.status === 200) { stockBox.replaceChildren(); say(addMsg, 'Stock updated.', true); reload(); } else say(m, errorText(r), false);
    } } },
    h('strong', {}, `Stock for: ${row.title || `book ${row.book_id}`}`),
    br ? h('label', { class: 'field' }, h('span', {}, 'Branch'), br) : null,
    h('label', { class: 'field' }, h('span', {}, 'Total copies'), copies),
    h('button', { class: 'btn', type: 'submit' }, 'Save stock'),
    h('button', { class: 'btn secondary', type: 'button', on: { click: () => stockBox.replaceChildren() } }, 'Cancel'), m));
  }

  listApi = listPage(box, {
    title: 'Books',
    path: '/api/books',
    searchFields: [['author', 'Author'], ['title', 'Title'], ['category', 'Category']],
    preferred: ['book_id', 'title', 'author', 'category', 'edition', 'price', 'fine_per_day', 'total_copies', 'available_copies', 'is_active'],
    above: h('div', {}, h('h3', {}, 'Add a book'), addForm, addMsg, stockBox),
    actions: (row, reload, msg) => [
      h('button', { class: 'btn secondary small', type: 'button', on: { click: () => { location.hash = `#book-${row.book_id}`; } } }, 'Details'),
      h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
        const v = window.prompt(`Fine per day (INR) for "${row.title || row.book_id}"`, row.fine_per_day !== undefined ? row.fine_per_day : '');
        if (v === null) return;
        if (!/^\d{1,6}(\.\d{1,2})?$/.test(v.trim())) { say(msg, 'Enter an amount like 5 or 7.50.', false); return; }
        const r = await api('PATCH', `/api/books/${row.book_id}`, { fine_per_day: Number(v) });
        say(msg, r.status === 200 ? 'Fine per day updated. It applies to new loans only.' : errorText(r) + fieldErrors(r), r.status === 200);
        if (r.status === 200) reload();
      } } }, 'Fine/day'),
      h('button', { class: 'btn secondary small', type: 'button', on: { click: () => openStock(row, reload) } }, 'Stock'),
      h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
        if (!window.confirm(`Remove "${row.title || row.book_id}" from the catalogue?`)) return;
        const r = await api('DELETE', `/api/books/${row.book_id}`);
        say(msg, r.status === 200 ? 'Book removed.' : errorText(r), r.status === 200);
        if (r.status === 200) reload();
      } } }, 'Remove'),
    ],
  });
};

// ---------- Members ----------
PageRenderers.members = async (box, ctx) => {
  const branches = await loadBranches(ctx);
  const n = textField('full_name', 'Full name', { required: true });
  const e = textField('email', 'Email', { type: 'email', required: true });
  const ph = textField('phone', 'Phone (+91...)', { inputmode: 'tel', maxlength: '20', required: true });
  const br = ctx.role === 'admin' ? branchSelect(branches) : null;
  const addMsg = h('div');
  let listApi = null;

  const addForm = h('form', { class: 'row-form', novalidate: true, on: { submit: async (ev) => {
    ev.preventDefault();
    const body = { full_name: n.input.value.trim(), email: e.input.value.trim(), phone: ph.input.value.trim() };
    if (br) body.home_branch_id = Number(br.value);
    const r = await api('POST', '/api/members', body);
    if (r.status === 201) { say(addMsg, 'Member registered.', true); addForm.reset(); listApi.reload(); } else say(addMsg, errorText(r) + fieldErrors(r), false);
  } } }, n.node, e.node, ph.node,
  br ? h('label', { class: 'field' }, h('span', {}, 'Branch'), br) : null,
  h('button', { class: 'btn', type: 'submit' }, 'Register member'));

  listApi = listPage(box, {
    title: 'Members',
    path: '/api/members',
    searchFields: [['search', 'Name, email or phone']],
    preferred: ['member_id', 'full_name', 'email', 'branch_name', 'registered_on', 'status', 'plan_name', 'expiry_date', 'is_active'],
    above: h('div', {}, h('h3', {}, 'Register a member'), addForm, addMsg),
    actions: (row, reload, msg) => {
      const active = row.is_active !== undefined ? !!row.is_active : row.status !== 'inactive';
      return [
        h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
          const r = await api('POST', `/api/members/${row.member_id}/account`);
          if (r.status === 201 || r.status === 200) {
            const pw = r.data && r.data.temporary_password;
            msg.replaceChildren(h('p', { class: 'msg ok', role: 'alert' },
              `Portal account ready for ${row.full_name}. Temporary password (shown once): `,
              h('strong', { class: 'secret' }, pw || '(not returned)')));
          } else say(msg, errorText(r), false);
        } } }, 'Portal account'),
        h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
          const r = await api('PATCH', `/api/members/${row.member_id}/status`, { is_active: !active });
          say(msg, r.status === 200 ? `Member ${active ? 'deactivated' : 'activated'}.` : errorText(r), r.status === 200);
          if (r.status === 200) reload();
        } } }, active ? 'Deactivate' : 'Activate'),
      ];
    },
  });
};
// ---------- Book details with QR ----------
PageRenderers.bookDetail = async (box, ctx, id) => {
  box.append(h('p', { class: 'hint' }, 'Loading...'));
  const [r, q] = await Promise.all([api('GET', `/api/books/${id}/details`), api('GET', `/api/books/${id}/qr`)]);
  if (r.status !== 200) { box.replaceChildren(h('p', { class: 'msg' }, errorText(r)), h('a', { href: '#books' }, 'Back to books')); return; }
  const d = r.data;
  const facts = Object.entries(d.book).filter(([, v]) => v === null || typeof v !== 'object');
  box.replaceChildren(h('div', { class: 'panel wide' },
    h('p', {}, h('a', { href: '#books' }, 'Back to books')),
    h('h2', {}, d.book.title || `Book ${id}`),
    h('p', { class: 'hint' }, `Showing ${d.scope}. Anyone scanning the QR must sign in first.`),
    h('div', { class: 'bookhead' },
      h('dl', {}, facts.map(([k, v]) => [h('dt', {}, label(k)), h('dd', {}, cell(v))])),
      q.status === 200 ? h('div', { class: 'qrbox' },
        h('img', { src: q.data.qr, alt: 'QR code linking to this book', width: '200', height: '200' }),
        h('p', { class: 'hint' }, q.data.link),
        h('button', { class: 'btn secondary small', type: 'button', on: { click: () => window.print() } }, 'Print')) : null),
    h('h3', {}, 'Summary'),
    h('div', { class: 'cards' }, Object.entries(d.summary).map(([k, v]) =>
      h('div', { class: 'stat' }, h('div', { class: 'num' }, cell(v)), h('div', { class: 'lbl' }, label(k))))),
    h('h3', {}, 'Stock per branch'), dataTable(d.stock, ['branch_name', 'total_copies', 'available_copies']),
    h('h3', {}, 'Borrowing history (latest 100)'),
    dataTable(d.loans, ['loan_id', 'member_name', 'branch_name', 'issue_date', 'due_date', 'return_date', 'loan_status', 'overdue_days', 'fine_amount', 'fine_paid'])));
};