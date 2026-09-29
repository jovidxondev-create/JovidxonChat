import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createTestEnv } from './support/env.js';

let env;
before(async () => {
  env = await createTestEnv('turn');
});
after(async () => {
  await env?.close();
});

/** Ҷавоби Cloudflare Realtime TURN (generate-ice-servers) бе дархости воқеӣ. */
function fakeCloudflare(requests, status = 200) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://rtc.live.cloudflare.com/')) {
      requests.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
      if (status !== 200) return new Response('{}', { status });
      return new Response(
        JSON.stringify({
          iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
            {
              urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
              username: 'cf-user',
              credential: 'cf-pass',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch(url, init);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe('calls: TURN', () => {
  test('Cloudflare TURN credentials are made on the server, cached, and the API token never reaches the app', async () => {
    const user = await env.user('turn_user');
    await env.ctx.settings.update({ calls_turn_cf_key_id: 'key-123', calls_turn_cf_api_token: 'cf-secret-token' }, null);
    const requests = [];
    const restore = fakeCloudflare(requests);
    try {
      const res = await env.api('GET', '/api/v1/calls/config', { token: user.token });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const servers = res.body.data.ice_servers;
      const turn = servers.find((server) => server.username === 'cf-user');
      assert.deepEqual(turn.urls, ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp']);
      assert.equal(turn.credential, 'cf-pass');
      assert.ok(servers.some((server) => server.urls.includes('stun:stun.cloudflare.com:3478')));
      assert.ok(!JSON.stringify(res.body).includes('cf-secret-token'));

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key-123/credentials/generate-ice-servers');
      assert.equal(requests[0].auth, 'Bearer cf-secret-token');
      assert.equal(requests[0].body.ttl, 86_400);

      await env.api('GET', '/api/v1/calls/config', { token: user.token });
      assert.equal(requests.length, 1, 'credentials are cached for an hour');
    } finally {
      restore();
    }
  });

  test('a Cloudflare outage still leaves STUN so calls on friendly networks work', async () => {
    const user = await env.user('turn_user2');
    await env.ctx.settings.update({ calls_turn_cf_key_id: 'key-other', calls_turn_cf_api_token: 'other-token' }, null);
    const requests = [];
    const restore = fakeCloudflare(requests, 503);
    try {
      const res = await env.api('GET', '/api/v1/calls/config', { token: user.token });
      assert.equal(res.status, 200);
      assert.equal(requests.length, 1);
      const servers = res.body.data.ice_servers;
      assert.ok(servers.every((server) => !server.username));
      assert.ok(servers.some((server) => server.urls.some((url) => url.startsWith('stun:'))));
    } finally {
      restore();
    }
  });
});
