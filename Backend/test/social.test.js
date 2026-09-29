import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createTestEnv } from './support/env.js';
import { jpegWithExif, multipart } from './support/fixtures.js';

let env;
before(async () => {
  env = await createTestEnv('social');
});
after(async () => {
  await env?.close();
});

async function createGroup(owner, members, name = 'Оилаи мо') {
  const res = await env.api('POST', '/api/v1/chats', {
    token: owner.token,
    body: { type: 'group', name, member_ids: members.map((m) => m.user.id) },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.chat;
}

describe('groups', () => {
  test('create, permissions, roles, mentions, invite, leave with ownership transfer', async () => {
    const owner = await env.user('grp_owner');
    const m1 = await env.user('grp_member1');
    const m2 = await env.user('grp_member2');
    const outsider = await env.user('grp_outsider');

    const chat = await createGroup(owner, [m1, m2]);
    assert.equal(chat.type, 'group');
    assert.equal(chat.title, 'Оилаи мо');
    assert.equal(chat.member_count, 3);

    const group = await env.api('GET', `/api/v1/groups/${chat.id}`, { token: m1.token });
    assert.equal(group.body.data.group.my_role, 'member');
    assert.deepEqual(group.body.data.group.my_permissions, {
      can_add_members: true,
      can_edit_info: false,
      can_send_messages: true,
      can_remove_members: false,
    });
    assert.equal((await env.api('GET', `/api/v1/groups/${chat.id}`, { token: outsider.token })).status, 404);

    // Member наметавонад ном иваз кунад.
    const rename = await env.api('PATCH', `/api/v1/groups/${chat.id}`, { token: m1.token, body: { name: 'Нав' } });
    assert.equal(rename.status, 403);
    assert.equal(rename.body.message, 'GROUP_PERMISSION_DENIED');

    // Owner → m1 admin.
    const promote = await env.api('POST', `/api/v1/groups/${chat.id}/members/${m1.user.id}/role`, { token: owner.token, body: { role: 'admin' } });
    assert.equal(promote.status, 200);
    assert.equal(promote.body.data.members.find((m) => m.user.id === m1.user.id).role, 'admin');
    const renamed = await env.api('PATCH', `/api/v1/groups/${chat.id}`, { token: m1.token, body: { name: 'Оила', description: 'Гурӯҳи оилавӣ' } });
    assert.equal(renamed.body.data.group.name, 'Оила');

    // m2 бе ҳуқуқи фиристодан.
    await env.api('PATCH', `/api/v1/groups/${chat.id}/members/${m2.user.id}/permissions`, {
      token: owner.token,
      body: { can_send_messages: false },
    });
    const muted = await env.send(m2, chat.id, 'салом');
    assert.equal(muted.status, 403);
    assert.equal(muted.body.message, 'GROUP_PERMISSION_DENIED');

    // Зикр (@username) mention_count-ро зиёд мекунад.
    await env.send(owner, chat.id, 'Салом @grp_member1 ва @nobody_here');
    const m1Chats = await env.api('GET', '/api/v1/chats', { token: m1.token });
    const m1Chat = m1Chats.body.data.chats.find((c) => c.id === chat.id);
    assert.equal(m1Chat.mention_count, 1);
    assert.equal(m1Chat.unread_count, 1);
    assert.equal(m1Chat.last_message_sender_name, 'grp_owner');

    // Даъват тавассути ҳалқа.
    const invite = await env.api('POST', `/api/v1/groups/${chat.id}/invite`, { token: owner.token });
    assert.match(invite.body.data.invite_link, /\/join\/[A-Za-z0-9_-]{22}$/);
    const join = await env.api('POST', '/api/v1/groups/join', { token: outsider.token, body: { invite_link: invite.body.data.invite_link } });
    assert.equal(join.status, 200);
    assert.equal(join.body.data.group.member_count, 4);
    await env.api('DELETE', `/api/v1/groups/${chat.id}/invite`, { token: owner.token });
    const late = await env.api('POST', '/api/v1/groups/join', { token: (await env.user()).token, body: { invite_link: invite.body.data.invite_link } });
    assert.equal(late.status, 404);

    // Admin наметавонад owner-ро хориҷ кунад; owner метавонад outsider-ро.
    assert.equal((await env.api('DELETE', `/api/v1/groups/${chat.id}/members/${owner.user.id}`, { token: m1.token })).status, 403);
    assert.equal((await env.api('DELETE', `/api/v1/groups/${chat.id}/members/${outsider.user.id}`, { token: owner.token })).status, 200);
    assert.equal((await env.api('GET', `/api/v1/chats/${chat.id}`, { token: outsider.token })).status, 404);

    // Owner мебарояд → моликият ба admin (m1).
    const left = await env.api('POST', `/api/v1/groups/${chat.id}/leave`, { token: owner.token });
    assert.deepEqual(left.body.data, { left: true, deleted: false });
    const after = await env.api('GET', `/api/v1/groups/${chat.id}`, { token: m1.token });
    assert.equal(after.body.data.group.my_role, 'owner');
    assert.equal(after.body.data.group.owner_id, m1.user.id);

    // Owner-и нав гурӯҳро нест мекунад.
    const del = await env.api('DELETE', `/api/v1/groups/${chat.id}`, { token: m1.token });
    assert.deepEqual(del.body.data, { deleted: true, removed: true });
    assert.equal((await env.api('GET', `/api/v1/chats/${chat.id}`, { token: m2.token })).status, 404);
  });

  test('realtime: members get chat.updated and removed members get chat.removed', async () => {
    const owner = await env.user('rtg_owner');
    const member = await env.user('rtg_member');
    const chat = await createGroup(owner, [member], 'RT');
    const ws = await env.socket(member);
    await env.api('PATCH', `/api/v1/groups/${chat.id}`, { token: owner.token, body: { name: 'RT 2' } });
    const updated = await ws.waitFor('chat.updated');
    assert.equal(updated.data.conversation_id, chat.id);
    await env.api('DELETE', `/api/v1/groups/${chat.id}/members/${member.user.id}`, { token: owner.token });
    const removed = await ws.waitFor('chat.removed');
    assert.equal(removed.data.conversation_id, chat.id);
    ws.close();
  });

  test('group avatar only from own image; last member leaving deletes the group', async () => {
    const owner = await env.user('grp_av');
    const other = await env.user('grp_av2');
    const chat = await createGroup(owner, [other], 'Avatar');
    const form = multipart({ kind: 'image' }, [{ field: 'file', name: 'g.jpg', data: await jpegWithExif() }]);
    const upload = await env.app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { authorization: `Bearer ${other.token}`, 'content-type': form.contentType },
      payload: form.body,
    });
    const mediaId = upload.json().data.media.id;
    const foreign = await env.api('PATCH', `/api/v1/groups/${chat.id}`, { token: owner.token, body: { avatar_media_id: mediaId } });
    assert.equal(foreign.status, 404);
    await env.api('POST', `/api/v1/groups/${chat.id}/leave`, { token: other.token });
    const last = await env.api('POST', `/api/v1/groups/${chat.id}/leave`, { token: owner.token });
    assert.deepEqual(last.body.data, { left: true, deleted: true });
  });
});

describe('stories', () => {
  test('create, privacy, feed order, views, viewers, reply → private chat', async () => {
    const author = await env.user('story_author');
    const friend = await env.user('story_friend');
    const stranger = await env.user('story_stranger');
    // Лента: ҳамсуҳбатони чати хусусӣ.
    const chat = await env.openChat(author, friend);
    await env.send(author, chat.id, 'салом');
    const chat2 = await env.openChat(stranger, author);
    await env.send(stranger, chat2.id, 'салом');

    const text = await env.api('POST', '/api/v1/stories', { token: author.token, body: { caption: 'Рӯзи хуб!', privacy: 'everyone' } });
    assert.equal(text.status, 200);
    assert.equal(text.body.data.story.type, 'text');
    assert.equal(text.body.data.story.is_mine, true);
    const contactsOnly = await env.api('POST', '/api/v1/stories', { token: author.token, body: { caption: 'Танҳо дӯстон', privacy: 'contacts' } });
    assert.equal(contactsOnly.status, 200);
    const empty = await env.api('POST', '/api/v1/stories', { token: author.token, body: {} });
    assert.equal(empty.status, 422);

    const friendFeed = await env.api('GET', '/api/v1/stories', { token: friend.token });
    assert.deepEqual(friendFeed.body.data.stories.map((s) => s.caption), ['Рӯзи хуб!', 'Танҳо дӯстон']);
    assert.equal(friendFeed.body.data.stories[0].is_viewed, false);
    assert.equal(friendFeed.body.data.stories[0].privacy, null);
    // stranger ба author навиштааст, аммо author ба stranger не → contacts намоён нест.
    const strangerFeed = await env.api('GET', '/api/v1/stories', { token: stranger.token });
    assert.deepEqual(strangerFeed.body.data.stories.map((s) => s.caption), ['Рӯзи хуб!']);
    assert.equal((await env.api('POST', `/api/v1/stories/${contactsOnly.body.data.story.id}/view`, { token: stranger.token })).status, 404);

    const storyId = text.body.data.story.id;
    await env.api('POST', `/api/v1/stories/${storyId}/view`, { token: friend.token });
    await env.api('POST', `/api/v1/stories/${storyId}/view`, { token: friend.token });
    const viewers = await env.api('GET', `/api/v1/stories/${storyId}/viewers`, { token: author.token });
    assert.equal(viewers.body.data.views_count, 1);
    assert.equal(viewers.body.data.viewers[0].user.id, friend.user.id);
    assert.equal((await env.api('GET', `/api/v1/stories/${storyId}/viewers`, { token: friend.token })).status, 404);

    const reply = await env.api('POST', `/api/v1/stories/${storyId}/reply`, { token: friend.token, body: { body: 'Зебо!' } });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.chat_id, chat.id);
    assert.equal(reply.body.data.message.body, 'Зебо!');

    const authorFeed = await env.api('GET', '/api/v1/stories', { token: author.token });
    assert.equal(authorFeed.body.data.stories[0].views_count, 1);
    assert.equal(authorFeed.body.data.stories[0].privacy, 'everyone');

    await env.api('DELETE', `/api/v1/stories/${storyId}`, { token: author.token });
    await env.db.exec("UPDATE stories SET expires_at = now() - interval '1 minute' WHERE id = $1", [contactsOnly.body.data.story.id]);
    const gone = await env.api('GET', '/api/v1/stories', { token: friend.token });
    assert.equal(gone.body.data.stories.length, 0);
  });
});

describe('calls', () => {
  test('ringing → accept → signals over WebSocket and REST → end with duration; busy; decline', async () => {
    const a = await env.user('call_alice');
    const b = await env.user('call_bob');
    const c = await env.user('call_carol');
    const config = await env.api('GET', '/api/v1/calls/config', { token: a.token });
    assert.deepEqual(config.body.data.ice_servers[0], { urls: ['stun:stun.l.google.com:19302'] });

    const wsB = await env.socket(b);
    const wsA = await env.socket(a);
    const start = await env.api('POST', '/api/v1/calls', { token: a.token, body: { user_id: b.user.id, type: 'video' } });
    assert.equal(start.status, 200);
    const call = start.body.data.call;
    assert.equal(call.status, 'ringing');
    assert.equal(call.direction, 'outgoing');
    const incoming = await wsB.waitFor('call.incoming');
    assert.equal(incoming.data.call.id, call.id);
    assert.equal(incoming.data.call.direction, 'incoming');
    assert.equal(incoming.data.call.peer.id, a.user.id);

    const busy = await env.api('POST', '/api/v1/calls', { token: c.token, body: { user_id: b.user.id } });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.message, 'CALL_UNAVAILABLE');
    assert.equal((await env.api('POST', `/api/v1/calls/${call.id}/accept`, { token: a.token })).status, 409);

    const accepted = await env.api('POST', `/api/v1/calls/${call.id}/accept`, { token: b.token });
    assert.equal(accepted.body.data.call.status, 'accepted');
    const updated = await wsA.waitFor((e) => e.type === 'call.updated' && e.data.call.status === 'accepted');
    assert.equal(updated.data.call.id, call.id);

    // Offer тавассути WS → B фавран.
    wsA.send('call.signal', { call_id: call.id, kind: 'offer', payload: { type: 'offer', sdp: 'v=0 fake' } });
    await wsA.waitFor('ack');
    const offer = await wsB.waitFor('call.signal');
    assert.equal(offer.data.signal.kind, 'offer');
    assert.deepEqual(offer.data.signal.payload, { type: 'offer', sdp: 'v=0 fake' });
    // Answer тавассути REST; polling-и захиравӣ.
    await env.api('POST', `/api/v1/calls/${call.id}/signals`, { token: b.token, body: { kind: 'answer', payload: { sdp: 'answer' } } });
    const polled = await env.api('GET', `/api/v1/calls/${call.id}/signals?after=0`, { token: a.token });
    assert.equal(polled.body.data.signals[0].kind, 'answer');
    assert.equal((await env.api('GET', `/api/v1/calls/${call.id}`, { token: c.token })).status, 404);

    await env.db.exec("UPDATE calls SET answered_at = now() - interval '65 seconds' WHERE id = $1", [call.id]);
    const ended = await env.api('POST', `/api/v1/calls/${call.id}/end`, { token: a.token });
    assert.equal(ended.body.data.call.status, 'ended');
    assert.ok(ended.body.data.call.duration_seconds >= 64);

    const second = await env.api('POST', '/api/v1/calls', { token: c.token, body: { user_id: b.user.id } });
    const declined = await env.api('POST', `/api/v1/calls/${second.body.data.call.id}/decline`, { token: b.token });
    assert.equal(declined.body.data.call.status, 'declined');
    const history = await env.api('GET', '/api/v1/calls', { token: b.token });
    assert.equal(history.body.data.calls.length, 2);
    wsA.close();
    wsB.close();
  });

  test('unanswered call becomes missed after ring timeout', async () => {
    const a = await env.user('miss_alice');
    const b = await env.user('miss_bob');
    const call = (await env.api('POST', '/api/v1/calls', { token: a.token, body: { user_id: b.user.id } })).body.data.call;
    await env.db.exec("UPDATE calls SET created_at = now() - interval '2 minutes' WHERE id = $1", [call.id]);
    const show = await env.api('GET', `/api/v1/calls/${call.id}`, { token: b.token });
    assert.equal(show.body.data.call.status, 'missed');
  });
});

describe('account deletion', () => {
  test('personal data is wiped, messages stay as "deleted account", phone can re-register', async () => {
    const a = await env.user('delete_me');
    const b = await env.user('keep_me');
    const chat = await env.openChat(a, b);
    await env.send(a, chat.id, 'хайр');
    const del = await env.api('DELETE', '/api/v1/me', { token: a.token });
    assert.deepEqual(del.body.data, { deleted: true });
    assert.equal((await env.api('GET', '/api/v1/me', { token: a.token })).status, 401);
    const view = await env.api('GET', `/api/v1/chats/${chat.id}/messages`, { token: b.token });
    assert.equal(view.body.data.messages[0].sender_name, 'Ҳисоби нестшуда');
    const fresh = await env.login(a.phone);
    assert.notEqual(fresh.user.id, a.user.id);
    assert.equal(fresh.is_new_user, true);
  });
});
