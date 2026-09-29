import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { clientMessageId, createTestEnv, sleep } from './support/env.js';

let env;
before(async () => {
  env = await createTestEnv('chats');
});
after(async () => {
  await env?.close();
});

describe('private chats', () => {
  test('open, visibility before first message, send, idempotency, unread, delivered, read', async () => {
    const a = await env.user('alice_chat');
    const b = await env.user('bob_chat');

    const chat = await env.openChat(a, b);
    assert.equal(chat.type, 'private');
    assert.equal(chat.title, 'bob_chat');
    assert.equal(chat.peer_id, b.user.id);
    const again = await env.openChat(a, b);
    assert.equal(again.id, chat.id);

    // Чати холӣ ба ҳамсуҳбат то паёми аввал намоён нест.
    let bChats = await env.api('GET', '/api/v1/chats', { token: b.token });
    assert.equal(bChats.body.data.chats.length, 0);

    const cid = clientMessageId();
    const sent = await env.api('POST', `/api/v1/chats/${chat.id}/messages`, {
      token: a.token,
      body: { client_message_id: cid, type: 'text', body: 'Салом, Боб!' },
    });
    assert.equal(sent.status, 200);
    const msg = sent.body.data.message;
    assert.equal(sent.body.data.duplicate, false);
    assert.equal(msg.seq, 1);
    assert.equal(msg.is_mine, true);
    assert.equal(msg.client_message_id, cid);
    assert.equal(msg.status, 'sent');
    assert.equal(msg.sender_name, 'alice_chat');

    const dup = await env.api('POST', `/api/v1/chats/${chat.id}/messages`, {
      token: a.token,
      body: { client_message_id: cid, type: 'text', body: 'Салом, Боб!' },
    });
    assert.equal(dup.body.data.duplicate, true);
    assert.equal(dup.body.data.message.id, msg.id);

    bChats = await env.api('GET', '/api/v1/chats', { token: b.token });
    const bChat = bChats.body.data.chats[0];
    assert.equal(bChat.id, chat.id);
    assert.equal(bChat.unread_count, 1);
    assert.equal(bChat.last_message_preview, 'Салом, Боб!');
    assert.equal(bChat.last_message_is_mine, false);
    assert.equal(bChat.title, 'alice_chat');

    // GET /chats-и B → «расонида шуд» барои A.
    const aView = await env.api('GET', `/api/v1/chats/${chat.id}/messages`, { token: a.token });
    assert.equal(aView.body.data.messages[0].status, 'delivered');
    assert.equal(aView.body.data.max_seq, 1);

    const bView = await env.api('GET', `/api/v1/chats/${chat.id}/messages`, { token: b.token });
    assert.equal(bView.body.data.messages[0].is_mine, false);
    assert.equal(bView.body.data.messages[0].client_message_id, undefined);

    const read = await env.api('POST', `/api/v1/messages/${msg.id}/read`, { token: b.token });
    assert.deepEqual(read.body.data, { conversation_id: chat.id, last_read_seq: 1, unread_count: 0 });
    const aAfter = await env.api('GET', `/api/v1/chats/${chat.id}/messages`, { token: a.token });
    assert.equal(aAfter.body.data.messages[0].status, 'read');
    const aChats = await env.api('GET', '/api/v1/chats', { token: a.token });
    assert.equal(aChats.body.data.chats[0].last_message_status, 'read');

    // read_receipts = false дар ҳар ду тараф → ҳадди аксар «delivered».
    await env.api('PATCH', '/api/v1/me/settings', { token: b.token, body: { read_receipts: false } });
    const hidden = await env.api('GET', `/api/v1/chats/${chat.id}/messages`, { token: a.token });
    assert.equal(hidden.body.data.messages[0].status, 'delivered');
    await env.api('PATCH', '/api/v1/me/settings', { token: b.token, body: { read_receipts: true } });
  });

  test('validation, reply, edit, delete, pagination', async () => {
    const a = await env.user('ann_msg');
    const b = await env.user('ben_msg');
    const chat = await env.openChat(a, b);

    const empty = await env.send(a, chat.id, '');
    assert.equal(empty.status, 422);
    assert.equal(empty.body.errors[0].field, 'body');
    const noMedia = await env.api('POST', `/api/v1/chats/${chat.id}/messages`, {
      token: a.token,
      body: { client_message_id: clientMessageId(), type: 'image', body: '' },
    });
    assert.equal(noMedia.body.errors[0].field, 'media_id');

    const ids = [];
    for (let i = 1; i <= 5; i++) ids.push((await env.send(a, chat.id, `паём ${i}`)).body.data.message.id);
    const reply = await env.send(b, chat.id, 'ҷавоб', { reply_to_id: ids[1] });
    assert.equal(reply.body.data.message.reply_to.id, ids[1]);
    assert.equal(reply.body.data.message.reply_to.preview, 'паём 2');
    assert.equal(reply.body.data.message.reply_to.sender_name, 'ann_msg');

    const page = await env.api('GET', `/api/v1/chats/${chat.id}/messages?limit=2`, { token: a.token });
    assert.deepEqual(page.body.data.messages.map((m) => m.seq), [5, 6]);
    const older = await env.api('GET', `/api/v1/chats/${chat.id}/messages?before_seq=5&limit=3`, { token: a.token });
    assert.deepEqual(older.body.data.messages.map((m) => m.seq), [2, 3, 4]);
    const newer = await env.api('GET', `/api/v1/chats/${chat.id}/messages?after_seq=4`, { token: a.token });
    assert.deepEqual(newer.body.data.messages.map((m) => m.seq), [5, 6]);

    const edit = await env.api('PATCH', `/api/v1/messages/${ids[0]}`, { token: a.token, body: { body: 'таҳриршуда' } });
    assert.equal(edit.body.data.message.body, 'таҳриршуда');
    assert.ok(edit.body.data.message.edited_at);
    const foreignEdit = await env.api('PATCH', `/api/v1/messages/${ids[0]}`, { token: b.token, body: { body: 'x' } });
    assert.equal(foreignEdit.status, 403);
    const foreignDelete = await env.api('DELETE', `/api/v1/messages/${ids[0]}`, { token: b.token });
    assert.equal(foreignDelete.status, 403);

    const lastId = reply.body.data.message.id;
    const del = await env.api('DELETE', `/api/v1/messages/${lastId}`, { token: b.token });
    assert.deepEqual(del.body.data, { message_id: lastId, is_deleted: true });
    const list = await env.api('GET', `/api/v1/chats/${chat.id}/messages`, { token: a.token });
    const deleted = list.body.data.messages.find((m) => m.id === lastId);
    assert.equal(deleted.is_deleted, true);
    assert.equal(deleted.body, '');
    const chats = await env.api('GET', '/api/v1/chats', { token: a.token });
    assert.equal(chats.body.data.chats.find((c) => c.id === chat.id).last_message_preview, 'паём 5');
  });

  test('outsiders get 404 everywhere; blocking stops sending', async () => {
    const a = await env.user('amy_block');
    const b = await env.user('bill_block');
    const x = await env.user('xena_out');
    const chat = await env.openChat(a, b);
    const msg = (await env.send(a, chat.id, 'махфӣ')).body.data.message;

    assert.equal((await env.api('GET', `/api/v1/chats/${chat.id}`, { token: x.token })).status, 404);
    assert.equal((await env.api('GET', `/api/v1/chats/${chat.id}/messages`, { token: x.token })).status, 404);
    assert.equal((await env.send(x, chat.id, 'hi')).status, 404);
    assert.equal((await env.api('POST', `/api/v1/messages/${msg.id}/read`, { token: x.token })).status, 404);
    assert.equal((await env.api('DELETE', `/api/v1/messages/${msg.id}`, { token: x.token })).status, 404);
    assert.equal((await env.api('GET', '/api/v1/chats/not-a-uuid', { token: a.token })).status, 404);

    await env.api('POST', '/api/v1/blocks', { token: b.token, body: { user_id: a.user.id } });
    const blocked = await env.send(a, chat.id, 'боз');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.message, 'USER_BLOCKED');
    const blocks = await env.api('GET', '/api/v1/blocks', { token: b.token });
    assert.equal(blocks.body.data.blocked[0].id, a.user.id);
    assert.equal(blocks.body.data.blocked[0].is_blocked, true);
    // Корбари блоккарда расм/last seen-и блоккунандаро намебинад.
    const seen = await env.api('GET', `/api/v1/users/${b.user.id}`, { token: a.token });
    assert.equal(seen.body.data.user.last_seen_at, null);
    await env.api('DELETE', `/api/v1/blocks/${a.user.id}`, { token: b.token });
    assert.equal((await env.send(a, chat.id, 'боз')).status, 200);

    const report = await env.api('POST', '/api/v1/reports', { token: b.token, body: { message_id: msg.id, reason: 'spam' } });
    assert.equal(report.body.data.reported, true);
    const same = await env.api('POST', '/api/v1/reports', { token: b.token, body: { message_id: msg.id, reason: 'spam' } });
    assert.equal(same.body.data.id, report.body.data.id);
  });

  test('pin, mute, archive, draft; new message unarchives', async () => {
    const a = await env.user('pia_prefs');
    const b = await env.user('pat_prefs');
    const chat = await env.openChat(a, b);
    await env.send(b, chat.id, 'салом');
    const patched = await env.api('PATCH', `/api/v1/chats/${chat.id}`, {
      token: a.token,
      body: { is_pinned: true, is_archived: true, draft: 'нимтамом' },
    });
    assert.equal(patched.body.data.chat.is_pinned, true);
    assert.equal(patched.body.data.chat.is_archived, true);
    assert.equal(patched.body.data.chat.draft, 'нимтамом');
    let list = await env.api('GET', '/api/v1/chats', { token: a.token });
    assert.ok(!list.body.data.chats.some((c) => c.id === chat.id));
    list = await env.api('GET', '/api/v1/chats?include_archived=1', { token: a.token });
    assert.ok(list.body.data.chats.some((c) => c.id === chat.id));
    await env.send(b, chat.id, 'боз');
    list = await env.api('GET', '/api/v1/chats', { token: a.token });
    assert.ok(list.body.data.chats.some((c) => c.id === chat.id));
  });

  test('search messages (Cyrillic prefix) and sync', async () => {
    const a = await env.user('sara_search');
    const b = await env.user('sam_search');
    const chat = await env.openChat(a, b);
    const since = new Date(Date.now() - 1000).toISOString();
    await env.send(a, chat.id, 'Фардо вохӯрем дар Душанбе');
    await env.send(b, chat.id, 'Хуб, соати 10');
    const found = await env.api('GET', '/api/v1/search/messages?q=душан', { token: b.token });
    assert.equal(found.body.data.messages.length, 1);
    assert.equal(found.body.data.messages[0].sender_name, 'sara_search');
    const short = await env.api('GET', '/api/v1/search/messages?q=x', { token: b.token });
    assert.equal(short.status, 422);

    const sync = await env.api('GET', `/api/v1/sync?since=${encodeURIComponent(since)}`, { token: b.token });
    assert.equal(sync.status, 200);
    assert.ok(sync.body.data.messages.length >= 2);
    assert.ok(sync.body.data.chats.some((c) => c.id === chat.id));
    assert.equal(sync.body.data.has_more, false);
    assert.ok(Date.parse(sync.body.data.server_time) < Date.now());
    const bad = await env.api('GET', '/api/v1/sync?since=yesterday', { token: b.token });
    assert.equal(bad.status, 422);
  });
});

describe('realtime (WebSocket)', () => {
  test('auth required and bad token closes socket', async () => {
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}/api/v1/ws`);
    await new Promise((resolve) => ws.once('open', resolve));
    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    ws.send(JSON.stringify({ type: 'auth', data: { token: 'f'.repeat(64) } }));
    assert.equal(await closed, 4001);
  });

  test('messages, receipts, typing, presence and session revocation are pushed instantly', async () => {
    const a = await env.user('rt_alice');
    const b = await env.user('rt_bob');
    const chat = await env.openChat(a, b);
    const wsA = await env.socket(a);
    const wsB = await env.socket(b);

    // Паём → ҳарду тараф фавран.
    const sent = (await env.send(a, chat.id, 'фаврӣ!')).body.data.message;
    const gotB = await wsB.waitFor((e) => e.type === 'message.created' && e.data.message.id === sent.id);
    assert.equal(gotB.data.conversation_id, chat.id);
    assert.equal(gotB.data.message.is_mine, false);
    assert.equal(gotB.data.message.body, 'фаврӣ!');
    assert.equal(gotB.data.message.client_message_id, undefined);
    const gotA = await wsA.waitFor((e) => e.type === 'message.created' && e.data.message.id === sent.id);
    assert.equal(gotA.data.message.is_mine, true);
    assert.equal(gotA.data.message.client_message_id, sent.client_message_id);

    // B «гирифт» → A receipt (delivered), баъд «хонд» → read.
    wsB.send('delivered', { conversation_id: chat.id, seq: sent.seq });
    const delivered = await wsA.waitFor((e) => e.type === 'receipt' && e.data.delivered_seq >= sent.seq);
    assert.equal(delivered.data.conversation_id, chat.id);
    await env.api('POST', `/api/v1/messages/${sent.id}/read`, { token: b.token });
    const read = await wsA.waitFor((e) => e.type === 'receipt' && e.data.read_seq >= sent.seq);
    assert.equal(read.data.conversation_id, chat.id);

    // Typing тавассути WS.
    wsB.send('typing', { conversation_id: chat.id, state: 'start' });
    const typing = await wsA.waitFor('typing');
    assert.deepEqual(typing.data, { conversation_id: chat.id, user_id: b.user.id, state: 'start' });
    const list = await env.api('GET', '/api/v1/chats', { token: a.token });
    const row = list.body.data.chats.find((c) => c.id === chat.id);
    assert.equal(row.is_typing, true);
    assert.equal(row.presence, 'typing');

    // Таҳрир ва нест кардан.
    await env.api('PATCH', `/api/v1/messages/${sent.id}`, { token: a.token, body: { body: 'иваз шуд' } });
    const updated = await wsB.waitFor('message.updated');
    assert.equal(updated.data.message.body, 'иваз шуд');
    await env.api('DELETE', `/api/v1/messages/${sent.id}`, { token: a.token });
    const removed = await wsB.waitFor('message.deleted');
    assert.equal(removed.data.message_id, sent.id);
    assert.equal(removed.data.message.is_deleted, true);

    // Presence: B ба A обуна → online; A мебарояд → offline.
    wsB.send('presence.subscribe', { user_ids: [a.user.id] });
    const online = await wsB.waitFor((e) => e.type === 'presence' && e.data.user_id === a.user.id);
    assert.equal(online.data.state, 'online');
    wsA.close();
    const offline = await wsB.waitFor((e) => e.type === 'presence' && e.data.state === 'offline');
    assert.equal(offline.data.user_id, a.user.id);
    assert.ok(offline.data.last_seen_at);

    // Logout → сокети ҳамон сессия баста мешавад.
    await env.api('POST', '/api/v1/auth/logout', { token: b.token });
    const closed = await wsB.closed;
    assert.equal(closed.code, 4001);
  });

  test('presence respects privacy (nobody)', async () => {
    const a = await env.user('priv_alice');
    const b = await env.user('priv_bob');
    await env.api('PATCH', '/api/v1/me/settings', { token: a.token, body: { privacy_last_seen: 'nobody' } });
    const wsB = await env.socket(b);
    wsB.send('presence.subscribe', { user_ids: [a.user.id] });
    const initial = await wsB.waitFor('presence');
    assert.equal(initial.data.state, 'offline');
    assert.equal(initial.data.last_seen_at, null);
    const wsA = await env.socket(a);
    await sleep(300);
    assert.ok(!wsB.events.some((e) => e.type === 'presence' && e.data.state === 'online'));
    wsA.close();
    wsB.close();
  });

  test('socket token is single-use', async () => {
    const a = await env.login();
    const token = (await env.api('POST', '/api/v1/auth/socket-token', { token: a.token })).body.data;
    assert.match(token.url, /^ws:\/\/.+\/api\/v1\/ws$/);
    assert.equal(token.expires_in, 60);
    const first = await env.ctx.auth.consumeSocketToken(token.token);
    assert.equal(first.user.id, a.user.id);
    assert.equal(await env.ctx.auth.consumeSocketToken(token.token), null);
  });
});
