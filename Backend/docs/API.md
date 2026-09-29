# JovidxonChat API v3 — маълумотнома (`/api/v1`)

Backend: Node.js (Fastify) + PostgreSQL + WebSocket. Ҳамаи роҳҳо нисбат ба **Base URL** ҳастанд:

| Насб | Base URL (Android `jovidxon.apiBaseUrl`) |
| --- | --- |
| Render (асосӣ) | `https://jovidxon-chat.onrender.com/` |
| Компютери худ | `http://127.0.0.1:8080/` (эмулятор: `http://10.0.2.2:8080/`) |

Масалан: `GET {base}api/v1/health`. Панели админ: `{base}admin/`.

Шакли JSON-и ҷавобҳо ва объектҳо бо API v2 (PHP) якхела аст — барномаи Android бе тағйир кор мекунад;
нав: WebSocket (§4), `POST /auth/socket-token`, сифати аслии медиа, API-и админ (§5).

---

## 1. Қоидаҳои умумӣ

### Сарлавҳаҳо (Android ҳамаашро мефиристад)

| Сарлавҳа | Вазифа |
| --- | --- |
| `Authorization: Bearer <access_token>` | ҳамаи роҳҳо ба ҷуз auth/health |
| `Accept-Language: tk` \| `ru` | забони SMS ва номҳои системавӣ |
| `X-Request-Id` | 6–64 аломат `[A-Za-z0-9._:-]`; дар ҷавоб ва лог ҳамон ID |
| `X-Device-Id`, `X-App-Version`, `User-Agent` | барои сессияҳо («Samsung SM-A515F (Android 14)») |

### Формати ҷавоб

Муваффақ:
```json
{ "success": true, "message": "OK", "data": { … }, "errors": [] }
```
Хато:
```json
{
  "success": false,
  "message": "VALIDATION_FAILED",
  "data": {},
  "errors": [ { "field": "phone", "code": "VALIDATION_FORMAT", "message_key": "error_validation_format" } ],
  "message_key": "error_validation_failed",
  "retryable": false
}
```
* `message` — code-и устувор (барои мантиқ), `message_key` — калиди `strings.xml` (барои матн).
* Хатои майдон: `code` = `VALIDATION_REQUIRED | _LENGTH | _FORMAT | _UNSUPPORTED | _SELF` → `error_validation_<rule>`.
* `429` ва `503` сарлавҳаи `Retry-After` (сония) доранд.

### Каталоги хатоҳо (`src/core/errors.js`)

| code | HTTP | message_key | retry |
| --- | --- | --- | --- |
| VALIDATION_FAILED | 422 | error_validation_failed | не |
| PAYLOAD_TOO_LARGE | 413 | error_validation_length | не |
| AUTH_UNAUTHORIZED | 401 | error_unauthorized | не |
| AUTH_TOKEN_EXPIRED | 401 | error_session_expired | ҳа (refresh) |
| AUTH_REFRESH_REVOKED | 401 | error_session_revoked | не → logout |
| AUTH_OTP_INVALID | 400 | error_otp_invalid | ҳа |
| AUTH_OTP_EXPIRED | 400 | error_otp_expired | ҳа |
| AUTH_OTP_COOLDOWN | 429 | error_otp_cooldown | баъди Retry-After |
| AUTH_OTP_RATE_LIMITED | 429 | error_otp_rate_limited | баъди Retry-After |
| AUTH_GOOGLE_INVALID | 401 | error_google_invalid | не |
| AUTH_GOOGLE_NOT_CONFIGURED | 503 | error_google_not_configured | не |
| ACCOUNT_SUSPENDED | 403 | error_account_suspended | не |
| REGISTRATION_CLOSED | 403 | error_permission_denied | не |
| SMS_SEND_FAILED | 503 | error_server | ҳа |
| USERNAME_TAKEN | 409 | error_username_taken | не |
| PHONE_TAKEN | 409 | error_phone_taken | не |
| PERMISSION_DENIED | 403 | error_permission_denied | не |
| GROUP_PERMISSION_DENIED | 403 | error_group_permission | не |
| USER_BLOCKED | 403 | error_user_blocked | не |
| NOT_FOUND | 404 | error_not_found | не |
| METHOD_NOT_ALLOWED | 405 | error_not_found | не |
| CONFLICT_VERSION | 409 | error_conflict | ҳа |
| RATE_LIMITED | 429 | error_rate_limited | ҳа |
| MEDIA_TOO_LARGE | 413 | error_media_too_large | не |
| MEDIA_TYPE_UNSUPPORTED | 415 | error_media_type | не |
| MEDIA_QUOTA_EXCEEDED | 413 | error_media_too_large | не |
| UPLOAD_FAILED | 400 | error_upload_failed | ҳа |
| CALL_UNAVAILABLE | 409 | error_call_unavailable | ҳа |
| ADMIN_SETUP_DONE | 409 | error_conflict | не |
| ADMIN_TOTP_REQUIRED | 401 | error_totp_required | не |
| ADMIN_LOCKED | 429 | error_rate_limited | баъди Retry-After |
| MAINTENANCE / SERVICE_MISCONFIGURED | 503 | error_maintenance | ҳа |
| SERVER_ERROR | 500 | error_server | ҳа |

### ID, вақт, саҳифабандӣ
* ID-ҳо — UUIDv7 (`01a0e1ca-91b1-7c44-…`), вақт-тартибнок, пешгӯинашаванда. ID-и нодуруст → `404`.
* Вақт — ISO-8601 UTC бо миллисония: `2026-09-27T10:15:30.123Z`.
* Паёмҳо рақами `seq` доранд (дар дохили чат 1, 2, 3 …). Саҳифа: `before_seq` (кӯҳнатар), `after_seq` (навтар), `limit` ≤ 100; натиҷа ҳамеша аз кӯҳна ба нав.
* Ғайриаъзо ба ҳар чиз (чат, паём, медиа, гурӯҳ, story, занг) → `404` (мавҷудият ошкор намешавад).

### Токенҳо
* `access_token` — JWT HS256, 15 дақиқа. Ҳар дархост сессияро месанҷад: revoke/suspend фавран амал мекунад.
* `refresh_token` — `rt1.<session_id>.<generation>.<hmac>`; **ҳар refresh токени нав медиҳад**.
  Токени пешина ~30 сония ҳамон ҷуфтро бармегардонад (дархостҳои мувозӣ); баъдтар — **дуздӣ**: тамоми сессия бекор мешавад.
* Дар база на токен ва на OTP нигоҳ дошта намешавад (танҳо HMAC). Калидҳо аз `APP_SECRET` (HKDF, барои ҳар вазифа алоҳида).

### Rate limit (`src/core/ratelimit.js`)

| Bucket | Ҳад |
| --- | --- |
| Роҳҳои кушода (аз як IP) | 120 / дақиқа |
| Ҳар корбар (умумӣ) | 300 / дақиқа |
| OTP: IP / рақам / рақам-рӯз / дастгоҳ | 20/соат · 5/соат · 10/рӯз · 10/соат (+ cooldown 60 с) |
| Тасдиқи OTP: IP / рақам | 60 / 15 дақ · 12 / 15 дақ (+ 5 кӯшиш барои як рамз) |
| Google / refresh (аз як IP) | 30 / 15 дақ · 60 / дақ |
| WebSocket: socket-token / пайвастшавӣ аз IP | 60 / дақ · 120 / дақ |
| Ҷустуҷӯ / ҷустуҷӯ бо рақам | 60 / дақ · 100 / соат |
| Фиристодани паём / typing | 120 / дақ · 90 / дақ |
| Upload | 200 / соат |
| Кушодани чат / сохтани гурӯҳ / пайвастшавӣ | 60 / соат · 20 / рӯз · 30 / соат |
| Шикоят / блок | 10 / соат · 30 / соат |
| Story / нест кардани ҳисоб | 30 / рӯз · 3 / рӯз |
| Занг / signaling | 30 / соат · 600 / дақ |

IP-и мизоҷ пас аз прокси-и Render аз `X-Forwarded-For` (аз рост ба чап, проксиҳои боэътимод гузаронида мешаванд) муайян мешавад —
`X-Forwarded-For`-и қалбакӣ лимитро намегузарад (`src/core/proxy.js`, `TRUST_PROXY`).

---

## 2. Объектҳо

**User**
```json
{ "id": "…", "display_name": "Фирӯза", "username": "firuza", "phone": "+992*****4567",
  "avatar_url": "/api/v1/media/…", "about": "Салом", "presence": "online",
  "last_seen_at": "2026-09-27T10:00:00.000Z", "is_deleted": false, "is_blocked": false }
```
* Телефони пурра танҳо барои худи корбар; дигарон — `+992*****4567`.
* `avatar_url`, `about`, `presence/last_seen_at` мувофиқи `privacy_*` (everyone | contacts | nobody) ва блок.
  «Контакт»-и шумо — касе, ки ба ӯ паём навиштаед. `presence = online` — пайвасти WebSocket ё фаъолият дар 60 сонияи охир.
* Ҳисоби нестшуда: `display_name` = «Ҳисоби нестшуда» / «Удалённый аккаунт», `is_deleted: true`.

**Chat (Conversation)**
```json
{ "id": "…", "type": "private", "title": "Фирӯза", "avatar_url": null, "peer_id": "…",
  "peer_last_seen_at": "…", "last_message_id": "…", "last_message_type": "image",
  "last_message_preview": "📷 Сурат", "last_message_at": "…", "last_message_is_mine": true,
  "last_message_status": "read", "last_message_sender_name": "Ман", "unread_count": 0,
  "mention_count": 0, "is_pinned": false, "is_muted": false, "is_archived": false,
  "is_typing": false, "draft": null, "presence": "online", "member_count": 2, "last_seq": 42 }
```
* Пешнамоиши медиа: `📷`, `🎬`, `🎤`, `📄 <номи файл>` (+ матн, агар caption бошад).
* `presence` барои чати хусусӣ: `online | offline | typing`.

**Message**
```json
{ "id": "…", "conversation_id": "…", "seq": 7, "sender_id": "…", "sender_name": "Фирӯза",
  "sender_avatar_url": null, "is_mine": true, "type": "text", "body": "Салом!",
  "created_at": "…", "status": "delivered", "reply_to": { "id": "…", "sender_name": "…", "preview": "…" },
  "edited_at": null, "is_deleted": false, "attachment": null, "client_message_id": "c-123…" }
```
* `status` барои паёмҳои худ: `sent` → `delivered` (ба дастгоҳи гиранда расид) → `read`.
  Агар яке аз ду тараф `read_receipts=false` дошта бошад — ҳадди аксар `delivered`. Дар гурӯҳ `read` = ҳама хонданд.
* `client_message_id` танҳо дар паёмҳои худи фиристанда.
* Нестшуда: `body: ""`, `attachment: null`, `is_deleted: true`.

**Attachment / Media**
```json
{ "id": "…", "type": "image", "file_name": "photo.jpg", "mime_type": "image/jpeg", "size_bytes": 4812345,
  "thumbnail_url": "/api/v1/media/…/thumb", "duration_seconds": null, "width": 4000, "height": 3000 }
```
URL-ҳо нисбӣ ҳастанд ва **Bearer token** мехоҳанд.

**Group** — `{ id (=chat id), group_id, name, avatar_url, description, owner_id, member_count, my_role, my_permissions{can_add_members, can_edit_info, can_send_messages, can_remove_members}, invite_link, created_at }`

**Story** — `{ id, author(User), type: image|video|text, media_id, media_url, caption, created_at, expires_at, is_mine, is_viewed, views_count }`

**Call** — `{ id, type: voice|video, status: ringing|accepted|declined|missed|cancelled|ended|failed, direction: incoming|outgoing, peer(User), conversation_id, created_at, answered_at, ended_at, end_reason, duration_seconds }`

---

## 3. Endpoint-ҳо

Нишонаҳо: 🔓 — бе токен; 🔒 — токен лозим.

### Система
| | Метод | Роҳ | Ҷавоб |
| --- | --- | --- | --- |
| 🔓 | GET | `/api/v1/health` | `{status: "ok", service, version, time}` (бе база; health check-и Render) |
| 🔓 | GET | `/api/v1/health/ready` | `{status: "ready", checks{database, schema, realtime}}` ё 503 |
| 🔓 | GET | `/api/v1/ws` | WebSocket (§4) |
| 🔓 | GET | `/join/{code}` | саҳифаи HTML барои ҳалқаи даъват |

### Auth
| | Метод | Роҳ | Бадан | Ҷавоб |
| --- | --- | --- | --- | --- |
| 🔓 | POST | `/auth/request-otp` | `{phone (E.164), device_id, platform, app_version, locale}` | `{phone, expires_in, resend_in, is_new_user: false}` |
| 🔓 | POST | `/auth/resend-otp` | ҳамон | ҳамон (cooldown 60 с → 429 `AUTH_OTP_COOLDOWN`) |
| 🔓 | POST | `/auth/verify-otp` | `{phone, code (4 рақам), device_id, platform, app_version, locale, fcm_token?, device_name?}` | `{user, tokens, is_new_user}` |
| 🔓 | POST | `/auth/google` | `{id_token, device_id, …}` | `{user, tokens, is_new_user}` |
| 🔓 | POST | `/auth/refresh` | `{refresh_token}` | `{tokens}` |
| 🔒 | POST | `/auth/logout` | — | `{revoked: true}` |
| 🔒 | POST | `/auth/logout-all` | — | `{revoked_sessions: n}` — **ҳамаи дастгоҳҳо ба ҷуз ҳозира** |
| 🔒 | POST | `/auth/socket-token` | — | `{token, expires_in: 60, url: "wss://…/api/v1/ws"}` — якдафъаина |

`tokens = {access_token, refresh_token, token_type: "Bearer", expires_in: 900, session_id}`.
`is_new_user = true` — корбари нав ё профили нимтамом (ном — пешфарз, username нест) → экрани профил.
`request-otp` ҳамеша `is_new_user: false` медиҳад (сабт будани рақам ошкор намешавад).
Хатоҳо: `AUTH_OTP_INVALID` (боз кӯшиш), `AUTH_OTP_EXPIRED` (рамзи нав), `AUTH_OTP_RATE_LIMITED` (5 кӯшиши нодуруст ё зиёд дархост),
`SMS_SEND_FAILED`, `ACCOUNT_SUSPENDED`, `AUTH_GOOGLE_INVALID`, `AUTH_GOOGLE_NOT_CONFIGURED`.

SMS: драйвери асосӣ ва эҳтиётӣ (`alif`, `smsgate`, `log`) аз панели админ интихоб мешаванд; ҳар кӯшиш дар «SMS log» (бе рамз).
Google: `id_token` дар сервер бо калидҳои ҷамъиятии Google (JWKS, кэш) санҷида мешавад; `aud` бояд дар `google_client_ids` бошад.

### Ман (профил, танзимот, сессияҳо)
| | Метод | Роҳ | Бадан | Ҷавоб |
| --- | --- | --- | --- | --- |
| 🔒 | GET | `/me` | — | `{user}` |
| 🔒 | PATCH | `/me` | `{display_name? 1–64, username? ^[a-z0-9_]{3,30}$ ("" — нест), about? ≤140}` | `{user}`; 409 `USERNAME_TAKEN` (field `username`) |
| 🔒 | DELETE | `/me` | — | `{deleted: true}` — ҳисоб нест мешавад |
| 🔒 | POST | `/me/avatar` | multipart `file` (сурат) | `{user, media}` |
| 🔒 | DELETE | `/me/avatar` | — | `{deleted: true}` |
| 🔒 | GET | `/me/settings` | — | `{settings}` |
| 🔒 | PATCH | `/me/settings` | ҳар майдон ихтиёрӣ | `{updated: true, settings}` |
| 🔒 | GET | `/me/sessions` | — | `{sessions: [{id, device_name, platform, app_version, location, created_at, last_active_at, is_current}]}` |
| 🔒 | DELETE | `/me/sessions/{id}` | — | `{revoked: true}` (WebSocket-и он сессия фавран баста мешавад) |

`settings = {language: tk|ru, theme: system|light|dark, read_receipts, privacy_last_seen, privacy_avatar, privacy_about (everyone|contacts|nobody), notify_messages, notify_groups, notify_calls, notify_preview}`.

Нест кардани ҳисоб: сессияҳо, дастгоҳҳо, Google-пайванд, блок/контактҳо, stories пок мешаванд; аз гурӯҳҳо мебарояд
(моликият ба admin мегузарад); телефон/ном/расм пок; паёмҳои фиристода барои дигарон бо номи «Ҳисоби нестшуда» мемонанд.
Рақам метавонад аз нав ҳамчун ҳисоби нав сабт шавад.

### Корбарон ва ҷустуҷӯ
| | Метод | Роҳ | Ҷавоб |
| --- | --- | --- | --- |
| 🔒 | GET | `/search/users?q=&limit=20` | `{users}` — username (префикс, `@` ихтиёрӣ), ном (қисман) ё **рақами пурраи E.164** |
| 🔒 | GET | `/users/{id}` | `{user}` |
| 🔒 | GET | `/search/messages?q=&limit=30&conversation_id=` | `{messages: [{id, conversation_id, seq, sender_id, sender_name, type, body, created_at}]}` |

Рақами нопурра ҷустуҷӯ намешавад; касе, ки шуморо блок кардааст, дар натиҷа нест. Ҷустуҷӯи паём — full-text-и PostgreSQL
(бе фарқи ҳарфи калон/хурд, кириллица ва ҳарфҳои тоҷикӣ).

### Чатҳо ва паёмҳо
| | Метод | Роҳ | Бадан | Ҷавоб |
| --- | --- | --- | --- | --- |
| 🔒 | GET | `/chats?include_archived=1` | — | `{chats}` (pinned аввал, баъд навтарин) |
| 🔒 | POST | `/chats` | `{type: "private", user_id}` ё `{type: "group", name, member_ids[]}` | `{chat}` (такрор — ҳамон чат) |
| 🔒 | GET | `/chats/{id}` | — | `{chat}` |
| 🔒 | PATCH | `/chats/{id}` | `{is_pinned?, is_muted?, is_archived?, draft?}` | `{chat}` (танҳо барои шумо) |
| 🔒 | GET | `/chats/{id}/members` | — | `{members: [{user, role, permissions, is_me, joined_at}]}` |
| 🔒 | POST | `/chats/{id}/typing` | `{state: start\|stop}` | `{typing}` (TTL ~6 с; беҳтараш тавассути WebSocket) |
| 🔒 | GET | `/chats/{id}/messages?before_seq=&after_seq=&limit=50` | — | `{messages, max_seq}` |
| 🔒 | POST | `/chats/{id}/messages` | `{client_message_id (8–64), type: text\|image\|video\|document\|voice, body (≤4096), media_id?, reply_to_id?}` | `{message, duplicate}` |
| 🔒 | PATCH | `/messages/{id}` | `{body}` | `{message}` (танҳо муаллиф, то 48 соат) |
| 🔒 | DELETE | `/messages/{id}` | — | `{message_id, is_deleted: true}` (муаллиф; дар гурӯҳ owner/admin) |
| 🔒 | POST | `/messages/{id}/read` | — | `{conversation_id, last_read_seq, unread_count}` |
| 🔒 | GET | `/sync?since=<ISO>&limit=200` | — | `{server_time, chats, messages, has_more}` |

* Idempotency: ҳамон `client_message_id` → ҳамон паём бо `duplicate: true` (такрори шабака дубликат намесозад).
* Медиа: аввал `POST /media`, баъд паём бо `media_id` ва `type` мувофиқи намуди файл. Медиаи дигарон (forward) иҷозат аст, агар шумо онро дида тавонед.
* Чати хусусӣ бо блок (дар ҳар ду самт) → 403 `USER_BLOCKED`; гурӯҳ бе `can_send_messages` → 403 `GROUP_PERMISSION_DENIED`.
* Паёми нав чатро аз архив мебарорад (агар хомӯш набошад); `@username` дар гурӯҳ `mention_count`-ро зиёд мекунад.
* Чати хусусии холӣ ба ҳамсуҳбат то паёми аввал намоён нест.
* Ҳар тағйирот фавран тавассути WebSocket ба аъзоёни онлайн меравад (§4); REST ҳамеша манбаи ҳақиқат аст.

### Медиа
| | Метод | Роҳ | Бадан / Ҷавоб |
| --- | --- | --- | --- |
| 🔒 | POST | `/media` | multipart: `kind` (image\|video\|voice\|document, **пеш аз** `file`), `file`, `duration_seconds?`, `width?`, `height?`, `thumbnail?` (JPEG-и постери видео) → `{media}` |
| 🔒 | GET | `/media/{id}` | файл; `Range` (206), `ETag`/`If-None-Match` (304), `Cache-Control: private, immutable` |
| 🔒 | GET | `/media/{id}/thumb` | JPEG ≤640px (сурат; видео — постери клиент) |
| 🔒 | DELETE | `/media/{id}` | `{deleted}` — танҳо медиаи худ, ки ба ҷое пайваст нест (вагарна 409) |

* **Сифати аслӣ**: сурат ва видео аз нав фишурда намешаванд — сервер файлро айнан нигоҳ медорад. Аз сурат танҳо metadata
  (EXIF/GPS, XMP, IPTC, шарҳҳо) бе талафоти сифат бурида мешавад; самти расм (orientation) боқӣ мемонад.
* Намуд аз **magic bytes** муайян мешавад (на аз номи файл): image — jpeg/png/webp/gif; video — mp4/3gp/mov/webm/mkv;
  voice — ogg/opus, m4a/aac, mp3, webm, 3gp/amr, wav, flac; document — pdf, office, zip/rar/7z, txt/csv/json/xml, …
  HTML/SVG/скриптҳо/EXE — не.
* Нигоҳдорӣ: дар PostgreSQL (қисмҳои 512 KB) — диски сервер истифода намешавад.
* Андозаҳо (панели админ → Танзимот): сурат 30 MB, видео 100 MB, овоз 16 MB, ҳуҷҷат 100 MB → 413 `MEDIA_TOO_LARGE`;
  намуди нодуруст → 415 `MEDIA_TYPE_UNSUPPORTED`.
* Ҳуқуқ: соҳиб; аъзои чате, ки паём бо ин медиа дорад; расми профил — мувофиқи `privacy_avatar`; расми гурӯҳ — аъзоён; story — мувофиқи privacy.

### Гурӯҳҳо (`{id}` = ID-и чати гурӯҳӣ)
| | Метод | Роҳ | Иҷозат | Бадан | Ҷавоб |
| --- | --- | --- | --- | --- | --- |
| 🔒 | GET | `/groups/{id}` | аъзо | — | `{group}` |
| 🔒 | PATCH | `/groups/{id}` | can_edit_info | `{name?, description?, avatar_media_id? ("" — нест)}` | `{group}` |
| 🔒 | DELETE | `/groups/{id}` | owner | — | `{deleted: true, removed: true}` |
| 🔒 | GET | `/groups/{id}/members` | аъзо | — | `{members}` |
| 🔒 | POST | `/groups/{id}/members` | can_add_members | `{user_ids[]}` | `{group, added[]}` |
| 🔒 | DELETE | `/groups/{id}/members/{userId}` | can_remove_members (худ → leave) | — | `{removed: true}` |
| 🔒 | POST | `/groups/{id}/members/{userId}/role` | owner | `{role: admin\|member}` | `{members}` |
| 🔒 | PATCH | `/groups/{id}/members/{userId}/permissions` | owner | `{can_*: bool}` | `{members}` |
| 🔒 | POST | `/groups/{id}/leave` | аъзо | — | `{left, deleted}` |
| 🔒 | POST | `/groups/{id}/invite` | can_edit_info | — | `{invite_link}` = `{PUBLIC_URL}/join/<рамз>` |
| 🔒 | DELETE | `/groups/{id}/invite` | can_edit_info | — | `{revoked: true}` |
| 🔒 | POST | `/groups/join` | — | `{invite_link}` (URL ё танҳо рамз) | `{group}` |

Нақшҳо: owner/admin — ҳамаи ихтиёрот; member — илова кардан ва фиристодан. Owner-ро хориҷ кардан мумкин нест;
admin-ро танҳо owner хориҷ мекунад. Баромадани owner → моликият ба admin (ё узви кӯҳнатарин); охирин узв → гурӯҳ нест.

### Stories
| | Метод | Роҳ | Бадан | Ҷавоб |
| --- | --- | --- | --- | --- |
| 🔒 | GET | `/stories` | — | `{stories}` — худам → надида → дида |
| 🔒 | POST | `/stories` | `{media_id? (сурат/видеои худ), caption ≤700, privacy: everyone\|contacts\|nobody}` | `{story}` |
| 🔒 | DELETE | `/stories/{id}` | — | `{deleted: true}` (муаллиф) |
| 🔒 | POST | `/stories/{id}/view` | — | `{viewed: true}` (идемпотент) |
| 🔒 | GET | `/stories/{id}/viewers` | — | `{viewers: [{user, viewed_at}], views_count}` (муаллиф) |
| 🔒 | POST | `/stories/{id}/reply` | `{body, client_message_id?}` | `{chat_id, message, duplicate}` |

Лента: stories-и худ ва ҳамсуҳбатони чатҳои хусусӣ; мӯҳлат 24 соат; блок — пинҳон; `contacts` — касоне, ки муаллиф ба онҳо навиштааст.

### Амният: блок ва шикоят
| | Метод | Роҳ | Бадан | Ҷавоб |
| --- | --- | --- | --- | --- |
| 🔒 | GET | `/blocks` | — | `{blocked: [user]}` |
| 🔒 | POST | `/blocks` | `{user_id}` | `{blocked: true}` |
| 🔒 | DELETE | `/blocks/{userId}` | — | `{unblocked: true}` |
| 🔒 | POST | `/reports` | `{user_id? , message_id?, reason: spam\|abuse\|scam\|other, comment? ≤500}` | `{reported: true, id}` |

### Дастгоҳҳо (push)
| | Метод | Роҳ | Бадан | Ҷавоб |
| --- | --- | --- | --- | --- |
| 🔒 | POST | `/devices` | `{device_id, platform, app_version, locale, fcm_token?, device_name?}` | `{device_id, registered: true}` |
| 🔒 | DELETE | `/devices/{deviceId}` | — | `{unregistered: true}` |

Push (агар FCM service account дар панели админ ворид шуда бошад) — танҳо data:
`{type: message, conversationId, messageId, senderName, preview, unreadCount, mention}`,
`{type: call, callId, callerId, callerName, callType}` (HIGH, 60 с), `{type: call_ended, callId}` — зангкунанда пеш аз ҷавоб қатъ кард
(ҳамон collapse key, зангӯла хомӯш мешавад). Паёмҳо — HIGH, TTL 1 рӯз. Mute ва `notify_*` риоя мешаванд.

### Зангҳо (signaling барои WebRTC)
| | Метод | Роҳ | Бадан | Ҷавоб |
| --- | --- | --- | --- | --- |
| 🔒 | GET | `/calls/config` | — | `{ice_servers: [{urls, username?, credential?}], ring_timeout}` — STUN + TURN (coturn secret, собит ё Cloudflare: калид дар сервер сохта мешавад) |
| 🔒 | POST | `/calls` | `{user_id, type: voice\|video}` | `{call}` (банд → 409 `CALL_UNAVAILABLE`) |
| 🔒 | GET | `/calls` | — | `{calls}` (таърих) |
| 🔒 | GET | `/calls/{id}` | — | `{call}` (45 с бе ҷавоб → `missed`) |
| 🔒 | POST | `/calls/{id}/accept` \| `/decline` \| `/end` | — | `{call}` |
| 🔒 | POST | `/calls/{id}/signals` | `{kind: offer\|answer\|ice\|renegotiate\|hangup, payload}` | `{signal_id}` |
| 🔒 | GET | `/calls/{id}/signals?after=` | — | `{signals: [{id, sender_id, kind, payload, created_at}], call}` |

Аудио/видео аз сервер намегузарад: клиентҳо тавассути WebRTC (STUN/TURN) пайваст мешаванд. Signaling ҳам тавассути
WebSocket (`call.signal`) кор мекунад — REST барои ҳолати бе WebSocket.

---

## 4. WebSocket (realtime, мисли WhatsApp)

1. `POST /api/v1/auth/socket-token` (бо Bearer) → `{token, url}`. Токен 60 сония ва **як бор** эътибор дорад
   (access token ба URL/лог намеравад).
2. Пайваст ба `wss://<host>/api/v1/ws` ва дар 5 сония фрейми аввал:
   `{"type": "auth", "data": {"token": "…", "locale": "tk"}}` → `{"v":1, "type":"ready", "data":{user_id, session_id, server_time}}`.
3. Ҳамаи фреймҳо JSON: `{"v": 1, "type": "…", "data": {…}}`. Сервер ҳар 25 с ping мефиристад (клиент pong).

**Клиент → сервер**

| type | data | Натиҷа |
| --- | --- | --- |
| `ping` | — | `pong {server_time}` |
| `typing` | `{conversation_id, state: start\|stop}` | ба аъзоёни дигар `typing` |
| `presence.subscribe` | `{user_ids: [...≤300]}` | иваз кардани рӯйхат + ҳолати ҳозира (`presence`) барои ҳар кас |
| `delivered` | `{conversation_id, seq}` | «расид» (✓✓) то ин `seq` |
| `call.signal` | `{call_id, kind, payload}` | `ack {signal_id}`; ба ҳамсуҳбат `call.signal` |

Хато: `{"type": "error", "data": {code, ref}}` (`ref` = `id`-и фрейми клиент, агар буд).

**Сервер → клиент**

| type | data |
| --- | --- |
| `message.created` \| `message.updated` \| `message.deleted` | `{conversation_id, message}` (+ `message_id` барои deleted) — `message` барои ҳар гиранда (`is_mine`, `status`) |
| `receipt` | `{conversation_id, delivered_seq, read_seq}` — барои паёмҳои худ |
| `typing` | `{conversation_id, user_id, state}` |
| `presence` | `{user_id, state: online\|offline, last_seen_at}` — танҳо барои обунашудаҳо ва мувофиқи privacy |
| `chat.updated` | `{conversation_id}` — чатро аз REST аз нав гиред |
| `chat.removed` | `{conversation_id}` — хориҷ шудед / гурӯҳ нест шуд |
| `call.incoming` \| `call.updated` | `{call}` |
| `call.signal` | `{call_id, signal}` |
| `resync` | `{}` — ҳама чизро аз REST аз нав гиред (масалан баъди барқароршавӣ) |

**Рамзҳои пӯшидан**: `4001` — токен нодуруст / сессия бекор шуд (токени нав гиред ё logout), `4003` — ҳисоб баста шуд,
`4008` — `auth` дар 5 с наомад, `4029` — пайвастҳои зиёд, `1012` — сервер аз нав оғоз мешавад (баъди чанд сония пайваст шавед).

Ҳодисаҳо байни дархостҳо тавассути PostgreSQL `LISTEN/NOTIFY` (канали `jovidxon_events`) интиқол меёбанд ва танҳо
**баъди COMMIT** фиристода мешаванд. Агар пайваст канда шавад, клиент бо backoff аз нав пайваст мешавад ва
`/sync` ё `/chats` ва `/chats/{id}/messages?after_seq=` маълумоти гумшударо бармегардонад.

---

## 5. API-и панели админ (`/api/v1/admin`)

Панели React дар `/admin/`. Сессия — cookie-и `jc_admin` (HttpOnly, SameSite=Strict, Secure, Path=/api/v1/admin);
ҳар дархости тағйирдиҳанда сарлавҳаи `X-CSRF-Token`-ро (аз ҷавоби login) мехоҳад. Пароль — scrypt; 5 кӯшиши нодуруст → қулф 15 дақ;
2FA (TOTP) ихтиёрӣ. Ҳар амали тағйирдиҳанда дар журнали аудит сабт мешавад.

| Метод | Роҳ | Ҳуқуқ |
| --- | --- | --- |
| GET / POST | `/setup` | насби якумин super_admin бо `setup_code` (танҳо вақте ки админ нест) |
| POST | `/auth/login` · `/auth/logout` · GET `/auth/me` | — |
| POST | `/me/password` · `/me/totp/setup` · `/me/totp/enable` · `/me/totp/disable` | худ |
| GET | `/stats` · `/stats/daily` | support |
| GET | `/users?q=&status=` · `/users/{id}` | support (рақами пурра — moderator) |
| POST | `/users/{id}/suspend` · `/unsuspend` · `/logout` | moderator |
| DELETE | `/users/{id}` | super_admin |
| GET / DELETE | `/groups` · `/groups/{id}` | support / moderator |
| GET / PATCH | `/reports` · `/reports/{id}` | support / moderator |
| GET · POST | `/sms` · `/sms/test` | moderator · super_admin |
| GET / PATCH | `/settings` | super_admin (калидҳои махфӣ бо AES-256-GCM рамзгузорӣ ва ҳеҷ гоҳ пурра нишон дода намешаванд) |
| GET / POST / PATCH / DELETE | `/admins` · `/admins/{id}` | super_admin |
| GET | `/audit` | super_admin |
| GET | `/system` | support |
| GET | `/media/{id}` · `/media/{id}/thumb` | support (медиаи шикоятҳо) |

Нақшҳо: **support** — дидан; **moderator** — блок, шикоятҳо, гурӯҳҳо, SMS log; **super_admin** — ҳама, аз ҷумла
танзимот ва админҳо.
