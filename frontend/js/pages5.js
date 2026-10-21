// Administration pages: staff accounts, branches, settings, audit log. Every value is inserted as text.

// ---------- Staff accounts ----------
PageRenderers.staff = async (box, ctx) => {
  const branches = await loadBranches(ctx);
  const u = textField('username', 'Username (3-50: letters, digits, . _ -)', { required: true, maxlength: '50' });
  const n = textField('full_name', 'Full name', { required: true });
  const br = branchSelect(branches);
  const addMsg = h('div');
  const detailBox = h('div');
  let listApi = null;

  const showTemp = (target, text, pw) => target.replaceChildren(h('p', { class: 'msg ok', role: 'alert' },
    `${text} Temporary password (shown once, give it to the person privately): `, h('strong', { class: 'secret' }, pw || '(not returned)')));

  const addForm = h('form', { class: 'row-form', novalidate: true, on: { submit: async (e) => {
    e.preventDefault();
    const r = await api('POST', '/api/staff', { username: u.input.value.trim(), full_name: n.input.value.trim(), branch_id: Number(br.value) });
    if (r.status === 201) {
      showTemp(addMsg, `Account ${r.data.staff.username} created. They must change the password at first sign-in.`, r.data.temporary_password);
      addForm.reset();
      listApi.reload();
    } else say(addMsg, errorText(r) + fieldErrors(r), false);
  } } }, u.node, n.node, h('label', { class: 'field' }, h('span', {}, 'Branch'), br),
  h('button', { class: 'btn', type: 'submit' }, 'Create staff account'));

  async function openActivity(row) {
    const r = await api('GET', `/api/staff/${row.user_id}`);
    if (r.status !== 200) { say(addMsg, errorText(r), false); return; }
    detailBox.replaceChildren(h('div', { class: 'panel wide' },
      h('h3', {}, `Recent activity: ${r.data.staff.username}`),
      h('p', { class: 'hint' }, `${r.data.staff.full_name}, ${cell(r.data.staff.branch_name)}. Last sign-in: ${cell(r.data.staff.last_login_at) || 'never'}. Latest 20 actions.`),
      dataTable(r.data.activity, ['created_at', 'action', 'entity_type', 'entity_id', 'details']),
      h('button', { class: 'btn secondary small', type: 'button', on: { click: () => detailBox.replaceChildren() } }, 'Close')));
  }

  listApi = listPage(box, {
    title: 'Staff accounts',
    path: '/api/staff',
    searchFields: [['search', 'Username or name'], ['role', 'Role (admin, staff)'], ['status', 'Status (active, inactive)'], ['branch_id', 'Branch ID']],
    preferred: ['user_id', 'username', 'full_name', 'role', 'branch_name', 'is_active', 'is_locked', 'must_change_password', 'last_login_at'],
    above: h('div', {}, h('h3', {}, 'Create a staff account'), addForm, addMsg, detailBox),
    actions: (row, reload, msg) => {
      if (row.role === 'admin') return [h('span', { class: 'hint' }, 'Managed outside the app')];
      const done = (r, ok) => { say(msg, r.status === 200 ? ok : errorText(r) + fieldErrors(r), r.status === 200); if (r.status === 200) reload(); };
      return [
        h('button', { class: 'btn secondary small', type: 'button', on: { click: () => openActivity(row) } }, 'Activity'),
        h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
          const v = window.prompt(`Full name for ${row.username}`, row.full_name);
          if (v === null || v.trim() === row.full_name) return;
          done(await api('PATCH', `/api/staff/${row.user_id}`, { full_name: v.trim() }), 'Name updated.');
        } } }, 'Rename'),
        h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
          const list = branches.map((b) => `${b.branch_id} = ${b.name}`).join('; ');
          const v = window.prompt(`Move ${row.username} to which branch ID?\n${list}`, String(row.branch_id));
          if (v === null || !/^\d+$/.test(v.trim()) || Number(v) === row.branch_id) return;
          done(await api('PATCH', `/api/staff/${row.user_id}`, { branch_id: Number(v) }), 'Branch changed. It applies from their next request.');
        } } }, 'Move branch'),
        h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
          done(await api('PATCH', `/api/staff/${row.user_id}/status`, { is_active: !row.is_active }), row.is_active ? 'Account deactivated. Their session ends now.' : 'Account reactivated.');
        } } }, row.is_active ? 'Deactivate' : 'Activate'),
        h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
          if (!window.confirm(`Reset the password for ${row.username}? They must change it at next sign-in.`)) return;
          const r = await api('POST', `/api/staff/${row.user_id}/reset-password`);
          if (r.status === 200) { showTemp(msg, `Password reset for ${row.username}.`, r.data.temporary_password); reload(); } else say(msg, errorText(r), false);
        } } }, 'Reset password'),
      ];
    },
  });
};

// ---------- Branches ----------
PageRenderers.branches = async (box) => {
  const name = textField('name', 'Branch name', { required: true, maxlength: '100' });
  const addr = textField('address', 'Address', { required: true, maxlength: '255' });
  const phone = textField('phone', 'Phone (optional)', { maxlength: '20' });
  const email = textField('email', 'Email (optional)', { maxlength: '120' });
  const msg = h('div');
  const detailBox = h('div');
  const out = h('div');

  const addForm = h('form', { class: 'row-form', novalidate: true, on: { submit: async (e) => {
    e.preventDefault();
    const body = { name: name.input.value.trim(), address: addr.input.value.trim() };
    if (phone.input.value.trim()) body.phone = phone.input.value.trim();
    if (email.input.value.trim()) body.email = email.input.value.trim();
    const r = await api('POST', '/api/branches', body);
    if (r.status === 201) { say(msg, 'Branch created.', true); addForm.reset(); load(); } else say(msg, errorText(r) + fieldErrors(r), false);
  } } }, name.node, addr.node, phone.node, email.node, h('button', { class: 'btn', type: 'submit' }, 'Create branch'));

  async function openDetail(row) {
    const r = await api('GET', `/api/branches/${row.branch_id}`);
    if (r.status !== 200) { say(msg, errorText(r), false); return; }
    const d = r.data;
    const cards = (obj) => h('div', { class: 'cards' }, Object.entries(obj).map(([k, v]) =>
      h('div', { class: 'stat' }, h('div', { class: 'num' }, cell(v)), h('div', { class: 'lbl' }, label(k)))));
    detailBox.replaceChildren(h('div', { class: 'panel wide' },
      h('h3', {}, d.branch.name), h('p', { class: 'hint' }, `${d.branch.address}. ${cell(d.branch.phone)} ${cell(d.branch.email)}`),
      h('h3', {}, 'Statistics'), cards(d.stats),
      h('h3', {}, 'Open items that block deactivation'), cards(d.blockers),
      h('h3', {}, 'Staff'), dataTable(d.staff, ['username', 'full_name', 'is_active', 'last_login_at']),
      h('button', { class: 'btn secondary small', type: 'button', on: { click: () => detailBox.replaceChildren() } }, 'Close')));
  }

  async function load() {
    const r = await api('GET', '/api/branches');
    if (r.status !== 200) { out.replaceChildren(h('p', { class: 'msg' }, errorText(r))); return; }
    const rows = firstArray(r.data);
    out.replaceChildren(dataTable(rows, pickKeys(rows, ['branch_id', 'name', 'address', 'phone', 'email', 'is_active']), (row) => [
      h('button', { class: 'btn secondary small', type: 'button', on: { click: () => openDetail(row) } }, 'Details'),
      h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
        const a = window.prompt(`Address for ${row.name}`, row.address || '');
        if (a === null) return;
        const p = window.prompt('Phone (leave empty to clear)', row.phone || '');
        if (p === null) return;
        const em = window.prompt('Email (leave empty to clear)', row.email || '');
        if (em === null) return;
        const r2 = await api('PATCH', `/api/branches/${row.branch_id}`, { address: a.trim(), phone: p.trim(), email: em.trim() });
        say(msg, r2.status === 200 ? 'Branch updated.' : errorText(r2) + fieldErrors(r2), r2.status === 200);
        if (r2.status === 200) load();
      } } }, 'Edit'),
      h('button', { class: 'btn secondary small', type: 'button', on: { click: async () => {
        const active = !!row.is_active;
        if (active && !window.confirm(`Deactivate ${row.name}? This is refused while it has open loans, pending payments, active staff or active members.`)) return;
        const r2 = await api('PATCH', `/api/branches/${row.branch_id}/status`, { is_active: !active });
        say(msg, r2.status === 200 ? `Branch ${active ? 'deactivated' : 'activated'}.` : errorText(r2), r2.status === 200);
        if (r2.status === 200) load();
      } } }, row.is_active ? 'Deactivate' : 'Activate'),
    ]));
  }

  box.append(h('div', { class: 'panel wide' }, h('h2', {}, 'Branches'),
    h('p', { class: 'hint' }, 'Branches are never deleted, only deactivated, so all history stays intact.'),
    h('h3', {}, 'Add a branch'), addForm, msg, detailBox, out));
  load();
};

// ---------- Settings ----------
PageRenderers.settings = async (box, ctx) => {
  const msg = h('div');
  const formBox = h('div');

  async function load() {
    const r = await api('GET', '/api/settings');
    if (r.status !== 200) { formBox.replaceChildren(h('p', { class: 'msg' }, errorText(r))); return; }
    const inputs = {};
    const rows = r.data.data.map((s) => {
      let input;
      if (s.type === 'flag') {
        input = h('select', { disabled: !s.editable }, h('option', { value: '0', selected: s.value !== '1' }, 'Off'), h('option', { value: '1', selected: s.value === '1' }, 'On'));
      } else {
        input = h('input', { type: 'text', value: s.value, maxlength: '100', disabled: !s.editable });
      }
      inputs[s.key] = { input, original: s.value, editable: s.editable };
      return h('label', { class: 'field' }, h('span', {}, s.label),
        input,
        h('div', { class: 'hint' }, s.note),
        s.updated_at ? h('div', { class: 'hint' }, `Last changed ${cell(s.updated_at)}${s.updated_by_name ? ` by ${s.updated_by_name}` : ''}`) : null);
    });
    const form = h('form', { novalidate: true, on: { submit: async (e) => {
      e.preventDefault();
      const body = {};
      for (const [k, o] of Object.entries(inputs)) if (o.editable && o.input.value.trim() !== o.original) body[k] = o.input.value.trim();
      if (!Object.keys(body).length) { say(msg, 'Nothing was changed.', false); return; }
      const pr = await api('PATCH', '/api/settings', body);
      if (pr.status === 200) { say(msg, `Saved: ${pr.data.changed.join(', ') || 'no changes'}. Changes apply to new records only.`, true); load(); } else say(msg, errorText(pr) + fieldErrors(pr), false);
    } } }, rows, ctx.role === 'admin' ? h('button', { class: 'btn', type: 'submit' }, 'Save changes') : null);
    formBox.replaceChildren(form);
  }

  box.append(h('div', { class: 'panel wide' }, h('h2', {}, 'Settings'),
    h('p', { class: 'hint' }, 'One wrong value rejects the whole save. Existing loans and requests keep the values they were created with. Leave the fine cap empty for no cap.'),
    msg, formBox));
  load();
};

// ---------- Audit log ----------
PageRenderers.audit = async (box) => {
  listPage(box, {
    title: 'Audit log',
    path: '/api/audit-logs',
    searchFields: [['search', 'Action or details'], ['username', 'Username'], ['action', 'Exact action'], ['entity_type', 'Entity type'], ['entity_id', 'Entity ID'], ['user_id', 'User ID']],
    preferred: ['audit_id', 'created_at', 'username', 'action', 'entity_type', 'entity_id', 'details'],
    above: h('p', { class: 'hint' }, 'Read-only history of who did what. Entries cannot be edited or deleted. Newest first.'),
  });
};