const { expireStalePayments } = require('./paymentExpiry');

const seconds = Number(process.env.SCHEDULER_INTERVAL_SECONDS);
const INTERVAL_MS = (Number.isFinite(seconds) && seconds >= 30 ? seconds : 300) * 1000;

let timer = null;
let first = null;
let running = false;

// Expires overdue payment requests. Never throws, and never overlaps with a run already in progress.
async function runExpiryJob() {
  if (running) return false;
  running = true;
  try {
    await expireStalePayments();
    return true;
  } catch (err) {
    console.error('Scheduled expiry failed:', err.message);
    return false;
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return timer;
  first = setTimeout(runExpiryJob, 5000);
  timer = setInterval(runExpiryJob, INTERVAL_MS);
  first.unref();
  timer.unref(); // the timers never keep the process alive on their own
  console.log(`Scheduler: expiring stale payment requests every ${INTERVAL_MS / 1000} seconds`);
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  if (first) clearTimeout(first);
  timer = null;
  first = null;
}

module.exports = { start, stop, runExpiryJob, isStarted: () => timer !== null };