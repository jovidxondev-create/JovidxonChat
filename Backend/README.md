# JovidxonChat — Backend (Node.js)

API, realtime (WebSocket) ва панели админ барои барномаи Android. Ҳамаи маълумот — корбарон, паёмҳо, **файлҳои
медиа**, танзимот, SMS log, пароли админ — дар **PostgreSQL** нигоҳ дошта мешавад; сервер ягон файли маҳаллӣ
намесозад (барои диски ephemeral-и Render мувофиқ).

| Қисм | Технология |
| --- | --- |
| HTTP API | Node.js ≥ 22.12, Fastify 5 (`/api/v1/*`) |
| Realtime | WebSocket (`/api/v1/ws`) + PostgreSQL `LISTEN/NOTIFY` |
| База | PostgreSQL 17 (`pg`), миграцияҳо ҳангоми оғоз худкор |
| Медиа | дар база (bytea, қисмҳои 512 KB), Range/ETag, sharp барои thumbnail |
| Панели админ | React (`../admin_panel`), дар `/admin/` аз ҳамин сервер |
| Deploy | Render (`../render.yaml`), қадамҳо — `../setup.md` |

Ҳуҷҷати пурраи API: [docs/API.md](docs/API.md).

## Сохтор

```
src/
  server.js        оғоз: миграция → танзимот → LISTEN → HTTP/WS → корҳои заминавӣ; SIGTERM — қатъи мулоим
  app.js           Fastify: parser-ҳо, сарлавҳаҳои амниятӣ, хатоҳо, панели админ (static + SPA)
  routes.js        ҷадвали ягонаи роҳҳо (auth бо нобаёнӣ, rate limit, реҷаи хизматӣ)
  presenters.js    объектҳои JSON (User, Chat, Message, …)
  config.js        тағйирёбандаҳои муҳит (.env.example)
  core/            хатоҳо, validator, crypto (HKDF, JWT, scrypt, AES-GCM), rate limit, прокси, i18n
  db/              pool, миграцияҳо (migrations/*.sql)
  services/        auth, sms, google, chats, groups, media/, stories, calls, push, realtime, admin, settings, …
test/              node:test + PostgreSQL-и муваққатӣ (embedded-postgres)
```

## Кор дар компютер

Лозим: Node.js 22.12+ ва PostgreSQL (маҳаллӣ ё базаи Render бо External URL ва IP-и шумо дар Access Control).

```bash
npm ci
cp .env.example .env        # DATABASE_URL ва APP_SECRET-ро пур кунед; SMS_DRIVER=log — рамз дар log
npm run build:admin         # панели админ → ../admin_panel/dist
npm run dev                 # http://localhost:8080  (панел: http://localhost:8080/admin/)
```

Панел бо hot reload: `cd ../admin_panel && npm run dev` → http://localhost:5173/admin/ (`/api` ба 8080 мегузарад).

Android (эмулятор, версияи debug): `./gradlew :app:installDebug -Pjovidxon.apiBaseUrlDebug=http://10.0.2.2:8080/`.

## Тестҳо

```bash
npm test
```

PostgreSQL-и муваққатӣ дар папкаи temp сохта ва баъд нест мешавад — базаи воқеӣ ва `.env` истифода намешаванд.
Ба ҷои он сервери худро додан мумкин аст: `TEST_DATABASE_URL=postgres://… npm test` (ҳар файли тест базаи алоҳида
месозад ва нест мекунад). Дар Windows `postgres.exe` аз номи администратор оғоз намешавад, бинобар ин тестҳо онро
тавассути `pg_ctl` оғоз мекунанд.

## Амният (кӯтоҳ)

* Access token — JWT 15 дақ; refresh — гардон, бо ошкор кардани дуздӣ; OTP ва токенҳо дар база танҳо ҳамчун HMAC.
* Калидҳо аз `APP_SECRET` (HKDF) — **пас аз оғоз иваз накунед**.
* Калидҳои SMS/FCM/TURN дар база бо AES-256-GCM рамзгузорӣ мешаванд ва дар панел пурра нишон дода намешаванд.
* Лог: на рамзи OTP, на токен, на пароль, на матни паём ва на рақами пурраи телефон.
* Сарлавҳаҳо: HSTS (production), `nosniff`, `no-referrer`, CSP-и сахт барои панел, `X-Frame-Options: DENY`.
* Панели админ: cookie-и HttpOnly + CSRF, scrypt, қулф баъди 5 хато, TOTP-и ихтиёрӣ, журнали аудит.
