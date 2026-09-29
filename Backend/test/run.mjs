/**
 * `npm test`: PostgreSQL-и муваққатӣ (embedded-postgres + pg_ctl) → node --test → қатъ.
 * Агар TEST_DATABASE_URL бошад (масалан CI), ҳамон сервер истифода мешавад.
 * Ҳар файли тест базаи алоҳида месозад ва дар охир нест мекунад — базаи воқеӣ ҳеҷ гоҳ даст намехӯрад.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function binDir() {
  const platform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  const dir = path.join(root, 'node_modules', '@embedded-postgres', `${platform}-${arch}`, 'native', 'bin');
  if (!fs.existsSync(dir)) throw new Error(`embedded postgres binaries not found: ${dir}`);
  return dir;
}

async function startPostgres() {
  const bin = binDir();
  const exe = (name) => path.join(bin, process.platform === 'win32' ? `${name}.exe` : name);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jovidxon-pg-'));
  const port = await freePort();
  // builtin C.UTF-8 (PG 17): lower()/ILIKE барои кириллица ва ҳарфҳои тоҷикӣ (ҷ, ӯ, ҳ, қ, ғ, ӣ) — мисли en_US.UTF-8 дар Render.
  const init = spawnSync(
    exe('initdb'),
    ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C', '--locale-provider=builtin', '--builtin-locale=C.UTF-8'],
    { stdio: 'ignore' },
  );
  if (init.status !== 0) throw new Error('initdb failed');
  // pg_ctl ҳуқуқҳои администраторро дар Windows маҳдуд мекунад (postgres.exe бевосита кор намекунад).
  const start = spawnSync(
    exe('pg_ctl'),
    ['-D', dataDir, '-o', `-p ${port} -h 127.0.0.1 -F -c max_connections=200`, '-l', path.join(dataDir, 'server.log'), '-w', '-t', '60', 'start'],
    { stdio: 'ignore' },
  );
  if (start.status !== 0) throw new Error(`pg_ctl start failed: ${fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8').slice(-2000)}`);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: () => {
      spawnSync(exe('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const pg = process.env.TEST_DATABASE_URL ? { url: process.env.TEST_DATABASE_URL, stop: () => {} } : await startPostgres();
const files = process.argv.slice(2);
const child = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', '--test-timeout=180000', ...(files.length ? files : ['test/*.test.js'])],
  { stdio: 'inherit', env: { ...process.env, TEST_PG_URL: pg.url, NODE_ENV: 'test' }, cwd: root },
);
const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
pg.stop();
process.exit(code);
