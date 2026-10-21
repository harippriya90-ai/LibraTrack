// Talks to the LibraTrack API. The token stays in sessionStorage, so closing the tab signs the user out.
const Session = {
  get token() { try { return sessionStorage.getItem('lt_token'); } catch (e) { return null; } },
  get kind() { try { return sessionStorage.getItem('lt_kind') || 'staff'; } catch (e) { return 'staff'; } },
  save(token, kind) {
    try { sessionStorage.setItem('lt_token', token); sessionStorage.setItem('lt_kind', kind); } catch (e) { /* storage blocked */ }
  },
  clear() {
    try { sessionStorage.removeItem('lt_token'); sessionStorage.removeItem('lt_kind'); } catch (e) { /* storage blocked */ }
  },
};

// Returns { status, data }. Never throws: a network failure comes back as status 0.
async function api(method, path, body) {
  const headers = {};
  if (Session.token) headers.Authorization = `Bearer ${Session.token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  try {
    const res = await fetch(path, { method, headers, body: payload });
    let data = null;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try { data = await res.json(); } catch (e) { data = null; }
    }
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { error: 'The server is not reachable. Check that it is running.' } };
  }
}

function errorText(r) {
  if (r.data && r.data.error) return r.data.error;
  return 'Something went wrong. Please try again.';
}