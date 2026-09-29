import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createTestEnv } from './support/env.js';

let env;
before(async () => {
  env = await createTestEnv('push');
});
after(async () => {
  await env?.close();
});

/** FCM иваз карда мешавад: ҳеҷ дархост ба Google намеравад. */
function fakeFcm() {
  const sent = [];
  env.ctx.push.fcm.configured = () => true;
  env.ctx.push.fcm.send = async (token, data, priority, collapseKey, ttl) => {
    sent.push({ token, data, priority, collapseKey, ttl });
    return { ok: true, unregistered: false, retryable: false, error: null };
  };
  return sent;
}

/** Шакли токени FCM (сервер ≥ 20 аломат мехоҳад). */
const token = (name) => `${name}:APA91b${"x".repeat(40)}`;

async function registerDevice(session, fcmToken) {
  const res = await env.api('POST', '/api/v1/devices', {
    token: session.token,
    body: { device_id: session.deviceId, platform: 'android', fcm_token: fcmToken },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function waitFor(list, count) {
  for (let i = 0; i < 100 && list.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('push (FCM)', () => {
  test('a new message reaches only the recipient device, with high priority and a one-day TTL', async () => {
    const sent = fakeFcm();
    const a = await env.user('push_sender');
    const b = await env.user('push_receiver');
    await registerDevice(a, token('a'));
    await registerDevice(b, token('b'));

    const chat = await env.openChat(a, b);
    const res = await env.send(a, chat.id, 'Салом, push!');
    assert.equal(res.status, 200);
    await waitFor(sent, 1);

    assert.equal(sent.length, 1);
    const [push] = sent;
    assert.equal(push.token, token('b'));
    assert.equal(push.priority, 'high');
    assert.equal(push.ttl, 86_400);
    assert.equal(push.collapseKey, `c:${chat.id}`);
    assert.equal(push.data.type, 'message');
    assert.equal(push.data.conversationId, chat.id);
    assert.equal(push.data.conversationType, 'private');
    assert.equal(push.data.senderName, 'push_sender');
    assert.equal(push.data.preview, 'Салом, push!');
  });

  test('a token that moves to another account stops receiving the old account pushes', async () => {
    const sent = fakeFcm();
    const a = await env.user('push_writer');
    const oldOwner = await env.user('push_old_owner');
    const newOwner = await env.user('push_new_owner');
    await registerDevice(oldOwner, token('shared'));
    await registerDevice(newOwner, token('shared'));

    const chat = await env.openChat(a, oldOwner);
    await env.send(a, chat.id, 'барои соҳиби кӯҳна');
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(sent, []);
  });

  test('an unanswered call rings with a high-priority push and a cancel stops it on the phone', async () => {
    const sent = fakeFcm();
    const caller = await env.user('push_caller');
    const callee = await env.user('push_callee');
    await registerDevice(callee, token('callee'));

    const start = await env.api('POST', '/api/v1/calls', { token: caller.token, body: { user_id: callee.user.id, type: 'video' } });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const callId = start.body.data.call.id;
    await waitFor(sent, 1);
    assert.equal(sent[0].data.type, 'call');
    assert.equal(sent[0].data.callId, callId);
    assert.equal(sent[0].data.callerId, caller.user.id);
    assert.equal(sent[0].data.callType, 'video');
    assert.equal(sent[0].priority, 'high');
    assert.equal(sent[0].ttl, 60);
    assert.equal(sent[0].collapseKey, `call:${callId}`);

    const end = await env.api('POST', `/api/v1/calls/${callId}/end`, { token: caller.token });
    assert.equal(end.status, 200);
    await waitFor(sent, 2);
    assert.equal(sent[1].data.type, 'call_ended');
    assert.equal(sent[1].data.callId, callId);
    assert.equal(sent[1].collapseKey, `call:${callId}`);
    assert.equal(sent[1].token, token('callee'));
  });

  test('ending an answered call sends no call_ended push', async () => {
    const sent = fakeFcm();
    const caller = await env.user('push_caller2');
    const callee = await env.user('push_callee2');
    await registerDevice(callee, token('callee2'));
    const start = await env.api('POST', '/api/v1/calls', { token: caller.token, body: { user_id: callee.user.id, type: 'voice' } });
    const callId = start.body.data.call.id;
    await waitFor(sent, 1);
    assert.equal((await env.api('POST', `/api/v1/calls/${callId}/accept`, { token: callee.token })).status, 200);
    assert.equal((await env.api('POST', `/api/v1/calls/${callId}/end`, { token: caller.token })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(sent.map((p) => p.data.type), ['call']);
  });
});
