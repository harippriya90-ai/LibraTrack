// LibraTrack web application shell: login, forced password change, sidebar, themes.
const root = document.getElementById('app');

// ---------- tiny DOM helper: every string becomes text, never HTML ----------
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) {
    if (k === null || k === undefined || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}
function mount(node) { root.replaceChildren(node); }

// ---------- themes ----------
const THEMES = [['light', 'Light'], ['dark', 'Dark'], ['colour', 'Colour']];
function getTheme() {
  try { return localStorage.getItem('lt_theme') || 'light'; } catch (e) { return 'light'; }
}
function applyTheme(t) {
  if (!THEMES.some(([k]) => k === t)) t = 'light';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('lt_theme', t); } catch (e) { /* storage blocked */ }
}
applyTheme(getTheme());

// ---------- navigation by role ----------
const PAGES = {
  home: { title: 'Home', note: 'Welcome page.' },
  dashboard: { title: 'Dashboard', note: 'Step 31: branch figures and alerts.' },
  books: { title: 'Books', note: 'Step 31: catalogue, stock per branch, e-book files.' },
  members: { title: 'Members', note: 'Step 31: registration, memberships, accounts.' },
  payments: { title: 'Payments', note: 'Step 32: payment requests, proof, verification.' },
  loans: { title: 'Loans', note: 'Step 32: issue and return books.' },
  fines: { title: 'Fines', note: 'Step 32: finalized fines, payments and waivers.' },
  incidents: { title: 'Incidents', note: 'Step 32: damage and loss reports and decisions.' },
  reports: { title: 'Reports', note: 'Step 33: reports, member history, printable page with QR.' },
  staff: { title: 'Staff accounts', note: 'Step 34: create, move, deactivate, reset password.' },
  branches: { title: 'Branches', note: 'Step 34: branch details and safe deactivation.' },
  settings: { title: 'Settings', note: 'Step 34: library name, fines, grace days, expiry.' },
  audit: { title: 'Audit log', note: 'Step 34: searchable, read-only history of actions.' },
  'my-loans': { title: 'My loans', note: 'Step 33: your borrowed books and fines.' },
  'my-catalogue': { title: 'Catalogue', note: 'Step 33: browse books and e-books.' },
  'my-profile': { title: 'My profile', note: 'Step 33: your membership and payments.' },
};
function navFor(kind, role) {
  if (kind === 'member') {
    return [['home'], ['my-loans'], ['my-catalogue'], ['my-profile']];
  }
  const nav = [['home'], ['dashboard'], ['books'], ['members'], ['payments'], ['loans'], ['fines'], ['incidents'], ['reports']];
  if (role === 'admin') nav.push(['group', 'Administration'], ['staff'], ['branches'], ['settings'], ['audit']);
  return nav;
}

// ---------- screens ----------
function brand(subtitle) {
  return h('header', {}, h('h1', {}, 'LibraTrack'), h('p', {}, subtitle));
}

function renderLogin(notice) {
  let kind = 'staff';
  const msg = h('div', { role: 'alert' });
  if (notice) msg.append(h('p', { class: 'msg' }, notice));
  const userLabel = h('span', {}, 'Username');
  const userInput = h('input', { type: 'text', autocomplete: 'username', required: true, maxlength: '100' });
  const passInput = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: '200' });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Sign in');
  const tabStaff = h('button', { type: 'button', role: 'tab', 'aria-selected': 'true' }, 'Staff');
  const tabMember = h('button', { type: 'button', role: 'tab', 'aria-selected': 'false' }, 'Member');

  function pick(k) {
    kind = k;
    tabStaff.setAttribute('aria-selected', String(k === 'staff'));
    tabMember.setAttribute('aria-selected', String(k === 'member'));
    userLabel.textContent = k === 'staff' ? 'Username' : 'Email address';
    userInput.type = k === 'staff' ? 'text' : 'email';
    userInput.autocomplete = k === 'staff' ? 'username' : 'email';
    msg.replaceChildren();
  }
  tabStaff.addEventListener('click', () => pick('staff'));
  tabMember.addEventListener('click', () => pick('member'));

  const form = h('form', { novalidate: true, on: { submit: async (ev) => {
    ev.preventDefault();
    msg.replaceChildren();
    const u = userInput.value.trim();
    const p = passInput.value;
    if (!u || !p) { msg.append(h('p', { class: 'msg' }, 'Enter your sign-in details.')); return; }
    submit.disabled = true;
    const r = kind === 'staff'
      ? await api('POST', '/api/auth/login', { username: u, password: p })
      : await api('POST', '/api/auth/member-login', { email: u, password: p });
    submit.disabled = false;
    if (r.status === 200 && r.data && r.data.token) {
      Session.save(r.data.token, kind);
      passInput.value = '';
      boot();
    } else {
      msg.append(h('p', { class: 'msg' }, errorText(r)));
      passInput.value = '';
      passInput.focus();
    }
  } } },
  msg,
  h('label', { class: 'field' }, userLabel, userInput),
  h('label', { class: 'field' }, h('span', {}, 'Password'), passInput),
  submit);

  mount(h('div', { class: 'center' },
    brand('Library management system'),
    h('main', {}, h('div', { class: 'card' },
      h('h2', {}, 'Sign in'),
      h('div', { class: 'tabs', role: 'tablist' }, tabStaff, tabMember),
      form)),
    h('footer', {}, 'Authorized use only. Sign-in attempts are limited and recorded.')));
  userInput.focus();
}

function renderChangePassword(kind, forced) {
  const msg = h('div', { role: 'alert' });
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: '200' });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', required: true, maxlength: '72' });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, maxlength: '72' });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Change password');
  const path = kind === 'member' ? '/api/auth/member-change-password' : '/api/auth/change-password';

  const form = h('form', { novalidate: true, on: { submit: async (ev) => {
    ev.preventDefault();
    msg.replaceChildren();
    const fail = (t) => msg.append(h('p', { class: 'msg' }, t));
    if (!cur.value || !nw.value) return fail('Fill in every field.');
    if (nw.value !== again.value) return fail('The two new passwords do not match.');
    if (nw.value.length < 8 || !/[A-Za-z]/.test(nw.value) || !/\d/.test(nw.value)) {
      return fail('The new password must be at least 8 characters with a letter and a number.');
    }
    submit.disabled = true;
    const r = await api('POST', path, { current_password: cur.value, new_password: nw.value });
    submit.disabled = false;
    if (r.status === 200) {
      boot('Password changed.');
    } else if (r.status === 401) {
      Session.clear();
      renderLogin('Your session ended. Please sign in again.');
    } else {
      fail(errorText(r));
    }
  } } },
  msg,
  h('label', { class: 'field' }, h('span', {}, forced ? 'Temporary password' : 'Current password'), cur),
  h('label', { class: 'field' }, h('span', {}, 'New password'), nw,
    h('div', { class: 'hint' }, '8 to 72 characters, with at least one letter and one number.')),
  h('label', { class: 'field' }, h('span', {}, 'Repeat new password'), again),
  h('div', {}, submit, ' ',
    forced
      ? h('button', { class: 'btn secondary', type: 'button', on: { click: () => { Session.clear(); renderLogin(); } } }, 'Sign out')
      : h('button', { class: 'btn secondary', type: 'button', on: { click: () => boot() } }, 'Cancel')));

  mount(h('div', { class: 'center' },
    brand('Library management system'),
    h('main', {}, h('div', { class: 'card' },
      h('h2', {}, forced ? 'Choose a new password' : 'Change password'),
      forced ? h('p', { class: 'msg' }, 'Your password is temporary. You must change it before you can continue.') : null,
      form)),
    h('footer', {}, '')));
  cur.focus();
}

function currentPage(nav) {
  const id = (location.hash || '#home').slice(1);
  if (/^book-\d+$/.test(id) && nav.some(([k]) => k === 'books')) return id;
  return nav.some(([k]) => k === id) ? id : 'home';
}

function renderShell(ctx, flash) {
  const { kind, name, role, branch } = ctx;
  const nav = navFor(kind, role);
  const shell = h('div', { class: 'shell' });
  const content = h('main', { class: 'content', id: 'content', tabindex: '-1' });
  const side = h('nav', { class: 'side', 'aria-label': 'Main' });

  function drawContent(id) {
    const p = PAGES[id] || PAGES.books;
    content.replaceChildren();
    if (flash && id === 'home') content.append(h('p', { class: 'msg ok', role: 'status' }, flash));
    flash = null;
    if (id === 'home') {
      content.append(h('div', { class: 'panel' },
        h('h2', {}, `Welcome, ${name}`),
        h('p', {}, kind === 'member'
          ? 'This is your member area. Your loans, the catalogue and your profile will open from the menu.'
          : 'Use the menu to work with books, members, payments, loans, fines and reports.'),
        h('dl', {},
          h('dt', {}, 'Signed in as'), h('dd', {}, name),
          h('dt', {}, 'Account type'), h('dd', {}, h('span', { class: 'pill' }, kind === 'member' ? 'Member' : role === 'admin' ? 'Administrator' : 'Branch staff')),
          branch ? [h('dt', {}, 'Branch'), h('dd', {}, branch)] : null)));
    } else if (/^book-\d+$/.test(id)) {
      const box = h('div');
      content.append(box);
      PageRenderers.bookDetail(box, ctx, Number(id.slice(5)));
    } else if (typeof PageRenderers !== 'undefined' && PageRenderers[id]) {
      const box = h('div');
      content.append(box);
      PageRenderers[id](box, ctx);
    } else {
      content.append(h('div', { class: 'panel' }, h('h2', {}, p.title), h('p', {}, p.note),
        h('p', { class: 'hint' }, 'This page is a placeholder. The shell, sign-in and access rules around it are live.')));
    }
    document.title = `${p.title} - LibraTrack`;
  }
  function drawNav(id) {
    side.replaceChildren(...nav.map((n) => (n[0] === 'group'
      ? h('div', { class: 'group' }, n[1])
      : h('a', { href: `#${n[0]}`, 'aria-current': (n[0] === id || (n[0] === 'books' && id.startsWith('book-'))) ? 'page' : false }, PAGES[n[0]].title))));
  }
  function route() {
    const id = currentPage(nav);
    drawNav(id);
    drawContent(id);
    shell.classList.remove('open');
  }

  const themeSel = h('select', { 'aria-label': 'Theme', on: { change: (e) => applyTheme(e.target.value) } },
    THEMES.map(([k, label]) => h('option', { value: k, selected: k === getTheme() }, label)));

  shell.append(
    h('header', { class: 'top' },
      h('button', { class: 'menu', type: 'button', 'aria-label': 'Menu', on: { click: () => shell.classList.toggle('open') } }, 'Menu'),
      h('h1', {}, 'LibraTrack'),
      h('div', { class: 'who' }, name, h('br'), kind === 'member' ? 'Member' : (role === 'admin' ? 'Administrator' : branch || 'Staff')),
      themeSel,
      h('button', { type: 'button', on: { click: () => renderChangePassword(kind, false) } }, 'Password'),
      h('button', { type: 'button', on: { click: () => { Session.clear(); renderLogin(); } } }, 'Sign out')),
    side, content);
  mount(shell);
  window.onhashchange = route;
  route();
}

// ---------- start-up: decide which screen to show ----------
async function boot(flash) {
  if (!Session.token) { renderLogin(); return; }
  const kind = Session.kind;

  if (kind === 'staff') {
    const r = await api('GET', '/api/auth/me');
    if (r.status === 401 || r.status === 403) { Session.clear(); renderLogin(errorText(r)); return; }
    if (r.status !== 200) { mount(h('p', { class: 'boot' }, errorText(r))); return; }
    const u = r.data.user;
    if (u.must_change_password) { renderChangePassword('staff', true); return; }
    renderShell({ kind: 'staff', name: u.full_name, role: u.role, branch: u.role === 'admin' ? null : u.branch_name }, flash);
    return;
  }

  // Members: /api/me stays open while a password change is pending, so probe a protected route.
  const probe = await api('GET', '/api/me/loans');
  if (probe.status === 403 && probe.data && probe.data.code === 'PASSWORD_CHANGE_REQUIRED') { renderChangePassword('member', true); return; }
  if (probe.status === 401 || (probe.status === 403)) { Session.clear(); renderLogin(errorText(probe)); return; }
  const me = await api('GET', '/api/me');
  if (me.status !== 200) { Session.clear(); renderLogin(errorText(me)); return; }
  const m = (me.data && (me.data.member || me.data.profile)) || me.data || {};
  renderShell({ kind: 'member', name: m.full_name || 'Member', role: 'member', branch: m.branch_name || m.home_branch_name || null }, flash);
}

boot();