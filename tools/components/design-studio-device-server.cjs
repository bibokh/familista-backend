'use strict';
// Familista Design Studio — a local server for measuring the 3D view on a real computer and phone.
//
// It is the setup half of tools/components/product-design-browser-proof.cjs, kept running for a person to use:
// the compiled application (`npm run build`), in production mode under the production CSP, listening on 127.0.0.1
// only. It migrates a database on this computer and creates one Platform Owner for the test if that email is not
// there yet. The procedure that uses it is docs/design-studio/DS-1c-real-device-performance.md. Nothing in the
// application, the build or CI requires or runs this file.
//
//   DEVICE_DB_URL          postgresql://user:password@localhost:5432/<database> — a database on THIS computer (required;
//                          any other host is refused). Use an empty database made for the test, never a shared one.
//   DEVICE_OWNER_EMAIL     the test owner's email (required)
//   DEVICE_OWNER_PASSWORD  the test owner's password, at least 12 characters (required; used only when the owner is created)
//
// Then open http://localhost:47934/ and sign in. Stop it with Ctrl+C. Session secrets are new on every start, so a
// restart signs everybody out.
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 47934;
const ORIGIN = `http://localhost:${PORT}`;

function stop(message) { console.error(message); process.exit(1); }

const url = process.env.DEVICE_DB_URL || '';
let parsed;
try { parsed = new URL(url); } catch (_) { stop('DEVICE_DB_URL must be a postgresql:// URL to a database on this computer.'); }
if (!/^postgres(ql)?:$/.test(parsed.protocol)) stop('DEVICE_DB_URL must be a postgresql:// URL.');
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) stop(`Refused: DEVICE_DB_URL points at ${parsed.hostname}. This tool only uses a database on this computer.`);
if (!parsed.pathname || parsed.pathname === '/' || parsed.pathname === '/postgres') stop('DEVICE_DB_URL must name a database made for the test (for example /familista_device), not the server\'s default database.');
const email = (process.env.DEVICE_OWNER_EMAIL || '').trim().toLowerCase();
const password = process.env.DEVICE_OWNER_PASSWORD || '';
if (!/^[^@\s]+@[^@\s]+$/.test(email)) stop('DEVICE_OWNER_EMAIL must be an email address.');
if (password.length < 12) stop('DEVICE_OWNER_PASSWORD must be at least 12 characters.');

process.env.NODE_ENV = 'production';
process.env.PORT = String(PORT);
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;
process.env.JWT_ACCESS_SECRET = crypto.randomBytes(32).toString('hex');
process.env.JWT_REFRESH_SECRET = crypto.randomBytes(32).toString('hex');
// The page's own origin, as production allowlists its own (src/app.ts refuses a same-origin POST from an unknown origin).
process.env.FRONTEND_URL = ORIGIN;

(async () => {
  console.log('Migrating the test database…');
  const m = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'], { cwd: ROOT, env: process.env, encoding: 'utf8', shell: process.platform === 'win32', timeout: 300000 });
  if (m.status !== 0) stop('prisma migrate deploy failed:\n' + (m.stderr || m.stdout || '').slice(-2000));

  const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'));
  const bcrypt = require(path.join(ROOT, 'node_modules/bcryptjs'));
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('familista.rls_mode', 'system', true)`;
      if (await tx.user.findUnique({ where: { email } })) { console.log(`The owner ${email} already exists; its password is unchanged.`); return; }
      const club = await tx.club.create({ data: { name: 'Device test club', city: 'Test' } });
      await tx.user.create({ data: { clubId: club.id, email, passwordHash: await bcrypt.hash(password, 12), firstName: 'Device', lastName: 'Owner', role: 'SUPER_ADMIN' } });
      console.log(`Created the Platform Owner ${email} for this test.`);
    });
  } finally { await db.$disconnect(); }

  const mod = require(path.join(ROOT, 'dist/app'));
  const app = (mod.createApp || mod.default || mod.app)();
  http.createServer(app).listen(PORT, '127.0.0.1', () => {
    console.log(`\nReady: open ${ORIGIN}/ , sign in as ${email}, then open Design Studio (${ORIGIN}/#product-design).`);
    console.log('Listening on 127.0.0.1 only. Stop with Ctrl+C.');
  });
})().catch((e) => stop(String(e && e.stack || e)));
