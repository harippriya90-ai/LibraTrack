fetch('/api/health')
  .then((r) => r.json())
  .then((d) => {
    document.getElementById('status').textContent = `${d.status}, database ${d.database}, ${d.branches} branches`;
  })
  .catch(() => {
    document.getElementById('status').textContent = 'the server is not reachable';
  });