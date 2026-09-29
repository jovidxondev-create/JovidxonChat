import { preview as previewText, truncate } from './core/text.js';
import { iso, mediaUrl, thumbUrl } from './services/users.js';

/**
 * Шакли JSON-и API — мувофиқи DTO-ҳои Android (data/remote/dto/*.kt).
 * Қоида: майдонҳое, ки дар Kotlin non-null ҳастанд, ҳеҷ гоҳ null фиристода намешаванд.
 */

function thumbnailFor(id, kind, hasThumb) {
  if (hasThumb) return thumbUrl(id);
  return kind === 'image' ? mediaUrl(id) : null;
}

export function presentMedia(row) {
  return {
    id: row.id,
    type: row.kind,
    file_name: row.original_name ?? null,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    thumbnail_url: thumbnailFor(row.id, row.kind, row.has_thumb),
    duration_seconds: row.duration_seconds ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    url: mediaUrl(row.id),
  };
}

const GLYPHS = { image: '📷', video: '🎬', voice: '🎤', document: '📄' };

/** Пешнамоиши паём (рӯйхати чатҳо, reply, push): медиа бо glyph, ки Android тарҷума мекунад. */
export function messagePreview(type, body, fileName) {
  const text = previewText(body ?? '', 160);
  const glyph = GLYPHS[type];
  if (!glyph) return text;
  if (text !== '') return `${glyph} ${text}`;
  if (type === 'document' && fileName) return `${glyph} ${truncate(fileName, 80)}`;
  return glyph;
}

/** receipts: {read, delivered, others, receipts(bool)} — ҳадди ақали дигар аъзоён. */
export function messageStatus(seq, isMine, receipts) {
  if (!isMine) return 'read';
  if (receipts.others === 0) return 'sent';
  if (receipts.receipts && seq <= receipts.read) return 'read';
  if (seq <= Math.max(receipts.delivered, receipts.read)) return 'delivered';
  return 'sent';
}

/**
 * row — сатри MESSAGE_SELECT; users — Map<id, userDto> барои ҳамин тамошобин.
 */
export function presentMessage(row, viewerId, users, receipts) {
  const isMine = row.sender_id === viewerId;
  const isDeleted = row.deleted_at !== null && row.deleted_at !== undefined;
  const sender = users.get(row.sender_id);
  const seq = Number(row.seq);

  let attachment = null;
  if (!isDeleted && row.att_id) {
    attachment = {
      id: row.att_id,
      type: row.att_kind,
      file_name: row.att_name ?? null,
      mime_type: row.att_mime ?? null,
      size_bytes: row.att_size !== null && row.att_size !== undefined ? Number(row.att_size) : null,
      thumbnail_url: thumbnailFor(row.att_id, row.att_kind, row.att_has_thumb),
      duration_seconds: row.att_duration ?? null,
      width: row.att_width ?? null,
      height: row.att_height ?? null,
    };
  }

  let replyTo = null;
  if (!isDeleted && row.reply_id) {
    replyTo = {
      id: row.reply_id,
      sender_name: users.get(row.reply_sender_id)?.display_name ?? '',
      preview: row.reply_deleted_at ? '' : messagePreview(row.reply_type, row.reply_body, row.reply_file_name),
    };
  }

  const message = {
    id: row.id,
    conversation_id: row.conversation_id,
    seq,
    sender_id: row.sender_id,
    sender_name: sender?.display_name ?? '',
    sender_avatar_url: sender?.avatar_url ?? null,
    is_mine: isMine,
    type: row.type,
    body: isDeleted ? '' : row.body,
    created_at: iso(row.created_at),
    status: messageStatus(seq, isMine, receipts),
    reply_to: replyTo,
    edited_at: isDeleted ? null : iso(row.edited_at),
    is_deleted: isDeleted,
    attachment,
  };
  if (isMine && row.client_message_id) message.client_message_id = row.client_message_id;
  return message;
}

/**
 * row — сатри CHAT_SELECT; users — Map<id, userDto>; typing — оё каси дигар менависад.
 */
export function presentConversation(row, viewerId, users, receiptsAllowed, typing) {
  const isGroup = row.type === 'group';
  const peerId = !isGroup ? (row.peer_id ?? null) : null;
  const peer = peerId ? users.get(peerId) : null;
  const hasLast = row.lm_seq !== null && row.lm_seq !== undefined;
  const lastIsMine = hasLast && row.lm_sender_id === viewerId;
  const lastSender = hasLast ? users.get(row.lm_sender_id) : null;
  const memberCount = Number(row.member_count ?? 1);

  let lastStatus = null;
  if (hasLast) {
    lastStatus = messageStatus(Number(row.lm_seq), lastIsMine, {
      read: Number(row.others_read_seq ?? 0),
      delivered: Number(row.others_delivered_seq ?? 0),
      others: Math.max(0, memberCount - 1),
      receipts: isGroup || receiptsAllowed,
    });
  }

  let presence = 'offline';
  if (!isGroup && peer) presence = typing ? 'typing' : (peer.presence ?? 'offline');

  const avatar = isGroup
    ? (row.group_avatar_media_id ? mediaUrl(row.group_avatar_media_id) : null)
    : (peer?.avatar_url ?? null);

  return {
    id: row.id,
    type: row.type,
    title: isGroup ? (row.group_name ?? '') : (peer?.display_name ?? ''),
    avatar_url: avatar,
    peer_id: peerId,
    peer_last_seen_at: peer?.last_seen_at ?? null,
    last_message_id: hasLast ? row.last_message_id : null,
    last_message_type: hasLast ? row.lm_type : null,
    last_message_preview: hasLast ? messagePreview(row.lm_type, row.lm_body, row.lm_file_name) : '',
    last_message_at: hasLast ? iso(row.lm_created_at) : null,
    last_message_is_mine: lastIsMine,
    last_message_status: lastStatus,
    last_message_sender_name: lastSender ? lastSender.display_name : null,
    unread_count: Number(row.unread_count ?? 0),
    mention_count: Number(row.mention_count ?? 0),
    is_pinned: Boolean(row.is_pinned),
    is_muted: Boolean(row.is_muted),
    is_archived: Boolean(row.is_archived),
    is_typing: Boolean(typing),
    draft: row.draft ? row.draft : null,
    presence,
    member_count: memberCount,
    last_seq: Number(row.last_seq ?? 0),
    created_at: iso(row.created_at),
  };
}

export function presentPermissions(member) {
  return {
    can_add_members: Boolean(member?.can_add_members),
    can_edit_info: Boolean(member?.can_edit_info),
    can_send_messages: Boolean(member?.can_send_messages),
    can_remove_members: Boolean(member?.can_remove_members),
  };
}

export function presentGroup(group, member, memberCount, inviteLink) {
  return {
    id: group.conversation_id,
    group_id: group.id,
    name: group.name,
    avatar_url: group.avatar_media_id ? mediaUrl(group.avatar_media_id) : null,
    description: group.description ?? '',
    owner_id: group.owner_id ?? '',
    member_count: memberCount,
    my_role: member.role,
    my_permissions: presentPermissions(member),
    invite_link: inviteLink,
    created_at: iso(group.created_at),
  };
}

export function presentStory(row, author, viewerId) {
  const isMine = row.user_id === viewerId;
  return {
    id: row.id,
    author,
    type: row.type,
    media_id: row.media_id ?? null,
    media_url: row.media_id ? mediaUrl(row.media_id) : null,
    caption: row.caption ?? '',
    privacy: isMine ? row.privacy : null,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    is_mine: isMine,
    is_viewed: isMine || Boolean(row.is_viewed),
    views_count: isMine ? Number(row.views_count ?? 0) : 0,
  };
}

export function presentSession(row, currentSessionId) {
  return {
    id: row.id,
    device_name: row.device_name ?? '',
    platform: row.platform ?? 'android',
    app_version: row.app_version ?? null,
    location: '',
    created_at: iso(row.created_at),
    last_active_at: iso(row.last_active_at),
    is_current: row.id === currentSessionId,
  };
}

export function presentSettings(row) {
  return {
    language: row?.language ?? 'tk',
    theme: row?.theme ?? 'system',
    read_receipts: row?.read_receipts ?? true,
    privacy_last_seen: row?.privacy_last_seen ?? 'everyone',
    privacy_avatar: row?.privacy_avatar ?? 'everyone',
    privacy_about: row?.privacy_about ?? 'everyone',
    notify_messages: row?.notify_messages ?? true,
    notify_groups: row?.notify_groups ?? true,
    notify_calls: row?.notify_calls ?? true,
    notify_preview: row?.notify_preview ?? true,
  };
}

export function presentCall(row, viewerId, users) {
  const outgoing = row.caller_id === viewerId;
  const peerId = outgoing ? row.callee_id : row.caller_id;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    direction: outgoing ? 'outgoing' : 'incoming',
    peer: users.get(peerId) ?? null,
    conversation_id: row.conversation_id ?? null,
    created_at: iso(row.created_at),
    answered_at: iso(row.answered_at),
    ended_at: iso(row.ended_at),
    end_reason: row.end_reason ?? null,
    duration_seconds: Number(row.duration_seconds ?? 0),
  };
}
