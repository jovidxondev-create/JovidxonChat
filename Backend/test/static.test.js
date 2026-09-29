import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createTestEnv } from './support/env.js';

let env;
let dist;
before(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'jovidxon-admin-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>admin</title><div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'assets', 'app-123.js'), 'console.log("admin")');
  env = await createTestEnv('static', { ADMIN_DIST: dist });
});
after(async () => {
  await env?.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

const get = (url) => env.app.inject({ method: 'GET', url });

test('admin panel is served from /admin with SPA fallback, cache and CSP headers', async () => {
  const root = await get('/');
  assert.equal(root.statusCode, 302);
  assert.equal(root.headers.location, '/admin/');
  const bare = await get('/admin');
  assert.equal(bare.statusCode, 302);
  assert.equal(bare.headers.location, '/admin/');

  const index = await get('/admin/');
  assert.equal(index.statusCode, 200);
  assert.match(index.body, /<div id="root">/);
  assert.match(index.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(index.headers['x-frame-options'], 'DENY');

  const spa = await get('/admin/users/0190a0e1-0000-7000-8000-000000000000');
  assert.equal(spa.statusCode, 200);
  assert.match(spa.body, /<div id="root">/);
  assert.equal(spa.headers['cache-control'], 'no-cache');

  const asset = await get('/admin/assets/app-123.js');
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers['content-type'], /javascript/);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');

  const missing = await get('/api/v1/unknown');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().message, 'NOT_FOUND');
});
