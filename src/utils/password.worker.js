// Familista — password hashing, off the request thread.
//
// Plain JavaScript rather than TypeScript, and shipped as-is: a worker is
// spawned by path, so it must exist at that path at runtime without a build
// step of its own. It is deliberately tiny — it does bcrypt and nothing else,
// and it holds no database handle, no configuration and no application state.

const { parentPort } = require('worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', (job) => {
  try {
    const value = job.op === 'hash'
      ? bcrypt.hashSync(job.password, job.rounds)
      : bcrypt.compareSync(job.password, job.hash);
    parentPort.postMessage({ id: job.id, value });
  } catch (err) {
    parentPort.postMessage({ id: job.id, error: (err && err.message) || 'password worker failed' });
  }
});
