const app = require('./app');
const pool = require('./config/db');

const PORT = Number(process.env.PORT || 3000);

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log('Database connection OK');
  } catch (err) {
    console.error('Database connection FAILED:', err.message);
    process.exit(1);
  }
  app.listen(PORT,'0.0.0.0', () => {
    console.log(`LibraTrack API running on http://localhost:${PORT}`);
  });
}

start();