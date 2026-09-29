-- 001: схемаи пурраи JovidxonChat (PostgreSQL 14+).
-- ID-ҳо: UUIDv7 (вақт-тартибнок, пешгӯинашаванда). Вақт: timestamptz (UTC).
-- Ҳамаи маълумот, аз ҷумла файлҳои медиа ва пароли админ, дар база нигоҳ дошта мешавад.

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- pg_trgm барои ҷустуҷӯи ном бо ILIKE '%...%' (агар дастрас набошад, ҷустуҷӯ бе индекс кор мекунад).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm is not available: %', SQLERRM;
END
$$;

-- ---------------------------------------------------------------- корбарон

CREATE TABLE users (
  id uuid PRIMARY KEY,
  phone text UNIQUE,
  username text UNIQUE,
  display_name text NOT NULL DEFAULT '',
  about text NOT NULL DEFAULT '',
  avatar_media_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  status_reason text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX users_status_created_idx ON users (status, created_at);
CREATE INDEX users_username_prefix_idx ON users (username text_pattern_ops);
CREATE INDEX users_avatar_idx ON users (avatar_media_id) WHERE avatar_media_id IS NOT NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX users_display_name_trgm_idx ON users USING gin (lower(display_name) gin_trgm_ops)';
  END IF;
END
$$;

CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  language text NOT NULL DEFAULT 'tk' CHECK (language IN ('tk', 'ru')),
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  read_receipts boolean NOT NULL DEFAULT true,
  privacy_last_seen text NOT NULL DEFAULT 'everyone' CHECK (privacy_last_seen IN ('everyone', 'contacts', 'nobody')),
  privacy_avatar text NOT NULL DEFAULT 'everyone' CHECK (privacy_avatar IN ('everyone', 'contacts', 'nobody')),
  privacy_about text NOT NULL DEFAULT 'everyone' CHECK (privacy_about IN ('everyone', 'contacts', 'nobody')),
  notify_messages boolean NOT NULL DEFAULT true,
  notify_groups boolean NOT NULL DEFAULT true,
  notify_calls boolean NOT NULL DEFAULT true,
  notify_preview boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_settings_touch BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- "Контакт"-и owner = касе, ки owner ба ӯ паём навиштааст. Барои privacy = contacts.
CREATE TABLE contacts (
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'phonebook', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, contact_id)
);
CREATE INDEX contacts_contact_idx ON contacts (contact_id);

-- ---------------------------------------------------------------- воридшавӣ

-- Refresh token = HMAC(session_id, generation, refresh_salt) — худи токен дар база нест.
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id text,
  device_name text,
  platform text NOT NULL DEFAULT 'android',
  app_version text,
  auth_method text NOT NULL DEFAULT 'otp' CHECK (auth_method IN ('otp', 'google')),
  refresh_salt text NOT NULL,
  refresh_generation integer NOT NULL DEFAULT 1,
  refresh_expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions (refresh_expires_at) WHERE revoked_at IS NULL;
CREATE INDEX sessions_revoked_idx ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;

-- OTP ҳеҷ гоҳ хом нигоҳ дошта намешавад: code_hash = HMAC(калиди сервер, phone|code).
CREATE TABLE otp_codes (
  id uuid PRIMARY KEY,
  phone text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  delivery text NOT NULL DEFAULT 'pending' CHECK (delivery IN ('pending', 'sent', 'failed', 'test')),
  ip text,
  device_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_phone_created_idx ON otp_codes (phone, created_at);
CREATE INDEX otp_created_idx ON otp_codes (created_at);

CREATE TABLE oauth_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google')),
  subject text NOT NULL,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (provider, subject)
);
CREATE INDEX oauth_user_idx ON oauth_accounts (user_id);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id text NOT NULL,
  device_name text,
  platform text NOT NULL DEFAULT 'android',
  app_version text,
  locale text NOT NULL DEFAULT 'tk' CHECK (locale IN ('tk', 'ru')),
  fcm_token text UNIQUE,
  push_enabled boolean NOT NULL DEFAULT true,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);
CREATE TRIGGER devices_touch BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Токени якдафъаинаи WebSocket (60 с). UNLOGGED: зуд, гум шуданаш ҳангоми crash бехатар аст.
CREATE UNLOGGED TABLE socket_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  device_id text,
  expires_at timestamptz NOT NULL
);
CREATE INDEX socket_tokens_expires_idx ON socket_tokens (expires_at);

-- ---------------------------------------------------------------- медиа (дар база)

-- Файл ба қисмҳои 512 KB тақсим мешавад (media_chunks) — upload/download бе нигоҳ доштани
-- тамоми файл дар хотира ва бо дастгирии Range. Сурат/видео бо сифати аслӣ.
CREATE TABLE media_files (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'video', 'voice', 'document')),
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready')),
  mime_type text NOT NULL,
  extension text NOT NULL,
  original_name text,
  size_bytes bigint NOT NULL DEFAULT 0,
  sha256 text,
  chunk_size integer NOT NULL,
  chunk_count integer NOT NULL DEFAULT 0,
  has_thumb boolean NOT NULL DEFAULT false,
  width integer,
  height integer,
  duration_seconds integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX media_owner_created_idx ON media_files (owner_id, created_at);
CREATE INDEX media_created_idx ON media_files (created_at);
CREATE INDEX media_deleted_idx ON media_files (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE media_chunks (
  media_id uuid NOT NULL REFERENCES media_files (id) ON DELETE CASCADE,
  idx integer NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (media_id, idx)
);
-- Медиа аллакай фишурда аст: бе pglz (зудтар ва substring-и арзон).
ALTER TABLE media_chunks ALTER COLUMN data SET STORAGE EXTERNAL;

CREATE TABLE media_thumbs (
  media_id uuid PRIMARY KEY REFERENCES media_files (id) ON DELETE CASCADE,
  mime_type text NOT NULL DEFAULT 'image/jpeg',
  width integer,
  height integer,
  data bytea NOT NULL
);

ALTER TABLE users ADD CONSTRAINT users_avatar_fk FOREIGN KEY (avatar_media_id) REFERENCES media_files (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- чатҳо

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('private', 'group')),
  pair_key text UNIQUE,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  last_message_id uuid,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX conversations_updated_idx ON conversations (updated_at);
CREATE TRIGGER conversations_touch BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Аъзогӣ (ва нақш/ихтиёроти гурӯҳ) — як манбаи ҳақиқат.
CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  can_add_members boolean NOT NULL DEFAULT true,
  can_edit_info boolean NOT NULL DEFAULT false,
  can_send_messages boolean NOT NULL DEFAULT true,
  can_remove_members boolean NOT NULL DEFAULT false,
  is_pinned boolean NOT NULL DEFAULT false,
  pinned_at timestamptz,
  is_muted boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  draft text,
  unread_count integer NOT NULL DEFAULT 0,
  mention_count integer NOT NULL DEFAULT 0,
  last_read_seq bigint NOT NULL DEFAULT 0,
  last_delivered_seq bigint NOT NULL DEFAULT 0,
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX members_user_idx ON conversation_members (user_id, conversation_id);
CREATE TRIGGER members_touch BEFORE UPDATE ON conversation_members FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE chat_groups (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL UNIQUE REFERENCES conversations (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  avatar_media_id uuid REFERENCES media_files (id) ON DELETE SET NULL,
  owner_id uuid REFERENCES users (id) ON DELETE SET NULL,
  invite_code text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX groups_owner_idx ON chat_groups (owner_id);
CREATE INDEX groups_avatar_idx ON chat_groups (avatar_media_id) WHERE avatar_media_id IS NOT NULL;
CREATE TRIGGER chat_groups_touch BEFORE UPDATE ON chat_groups FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- seq — рақами тартиб дар дохили чат (саҳифабандӣ, sync, WebSocket).
-- client_message_id — idempotency: такрори дархост дубликат намесозад.
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  sender_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_message_id text,
  type text NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'image', 'video', 'document', 'voice', 'system')),
  body text NOT NULL DEFAULT '',
  reply_to_id uuid REFERENCES messages (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid,
  -- lower() аз collation-и база (Unicode), на аз ctype — ҷустуҷӯи кириллӣ бе фарқи ҳарфи калон/хурд.
  body_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', lower(body))) STORED,
  UNIQUE (conversation_id, seq),
  UNIQUE (sender_id, client_message_id)
);
CREATE INDEX messages_conversation_updated_idx ON messages (conversation_id, updated_at);
CREATE INDEX messages_updated_idx ON messages (updated_at);
CREATE INDEX messages_reply_idx ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX messages_body_tsv_idx ON messages USING gin (body_tsv);
CREATE TRIGGER messages_touch BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
-- conversations.last_message_id — нишондиҳандаи денормализатсияшуда (бе FK: паёмҳо танҳо soft-delete мешаванд).

CREATE TABLE message_attachments (
  message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  media_id uuid NOT NULL REFERENCES media_files (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, position)
);
CREATE INDEX attachments_media_idx ON message_attachments (media_id);

-- ---------------------------------------------------------------- stories

CREATE TABLE stories (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('image', 'video', 'text')),
  media_id uuid REFERENCES media_files (id) ON DELETE SET NULL,
  caption text NOT NULL DEFAULT '',
  privacy text NOT NULL DEFAULT 'everyone' CHECK (privacy IN ('everyone', 'contacts', 'nobody')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX stories_user_expires_idx ON stories (user_id, expires_at);
CREATE INDEX stories_expires_idx ON stories (expires_at) WHERE deleted_at IS NULL;
CREATE INDEX stories_media_idx ON stories (media_id) WHERE media_id IS NOT NULL;

CREATE TABLE story_views (
  story_id uuid NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id)
);
CREATE INDEX story_views_viewer_idx ON story_views (viewer_id);

-- ---------------------------------------------------------------- амният

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

CREATE TABLE reports (
  id uuid PRIMARY KEY,
  reporter_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  target_message_id uuid REFERENCES messages (id) ON DELETE SET NULL,
  target_conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
  reason text NOT NULL DEFAULT 'other' CHECK (reason IN ('spam', 'abuse', 'scam', 'other')),
  comment text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'rejected')),
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_status_idx ON reports (status, created_at);
CREATE INDEX reports_reporter_idx ON reports (reporter_id, created_at);
CREATE INDEX reports_target_user_idx ON reports (target_user_id);
CREATE TRIGGER reports_touch BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------- push

CREATE TABLE push_outbox (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  collapse_key text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX push_outbox_queue_idx ON push_outbox (available_at) WHERE status = 'queued';
CREATE INDEX push_outbox_created_idx ON push_outbox (created_at);

-- ---------------------------------------------------------------- зангҳо (WebRTC signaling)

CREATE TABLE calls (
  id uuid PRIMARY KEY,
  caller_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  callee_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
  type text NOT NULL DEFAULT 'voice' CHECK (type IN ('voice', 'video')),
  status text NOT NULL DEFAULT 'ringing'
    CHECK (status IN ('ringing', 'accepted', 'declined', 'missed', 'cancelled', 'ended', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  duration_seconds integer NOT NULL DEFAULT 0
);
CREATE INDEX calls_caller_idx ON calls (caller_id, created_at);
CREATE INDEX calls_callee_idx ON calls (callee_id, created_at);
CREATE INDEX calls_active_idx ON calls (status, created_at) WHERE status IN ('ringing', 'accepted');

CREATE TABLE call_signals (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('offer', 'answer', 'ice', 'renegotiate', 'hangup')),
  payload text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_signals_recipient_idx ON call_signals (call_id, recipient_id, id);
CREATE INDEX call_signals_created_idx ON call_signals (created_at);

-- ---------------------------------------------------------------- хидматӣ

CREATE UNLOGGED TABLE rate_limits (
  bucket text NOT NULL,
  window_start bigint NOT NULL,
  hits integer NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX rate_limits_expires_idx ON rate_limits (expires_at);

-- Логи SMS: рақами пӯшида ва ҳолат — на матн ва на рамз.
CREATE TABLE sms_logs (
  id uuid PRIMARY KEY,
  phone_masked text NOT NULL,
  template text NOT NULL,
  driver text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'delivered')),
  provider_id text,
  error text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_logs_created_idx ON sms_logs (created_at);
CREATE INDEX sms_logs_status_idx ON sms_logs (status, created_at);

CREATE TABLE app_state (
  name text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- админ

CREATE TABLE admin_users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'support' CHECK (role IN ('super_admin', 'moderator', 'support')),
  display_name text NOT NULL DEFAULT '',
  totp_secret text,
  totp_enabled boolean NOT NULL DEFAULT false,
  totp_last_counter bigint,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER admin_users_touch BEFORE UPDATE ON admin_users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);

CREATE TABLE admin_audit_logs (
  id bigserial PRIMARY KEY,
  admin_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  actor text NOT NULL,
  action text NOT NULL,
  target text,
  details jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_admin_idx ON admin_audit_logs (admin_id, created_at);
CREATE INDEX audit_action_idx ON admin_audit_logs (action, created_at);
CREATE INDEX audit_created_idx ON admin_audit_logs (created_at);

-- Танзимоти барнома (SMS, Google, лимитҳо, реҷаи хизматӣ ...) — аз панели админ иваз мешаванд.
-- Қиматҳои махфӣ бо AES-256-GCM рамзгузорӣ шудаанд (калид аз APP_SECRET).
CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  is_secret boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
