# JovidxonChat — насб дар Render (Setup)

> Маълумотномаи API: [`Backend/docs/API.md`](Backend/docs/API.md) · Барои барномасоз: [`Backend/README.md`](Backend/README.md)
> · Blueprint: [`render.yaml`](render.yaml)

## 0. Хулоса: чӣ нав шуд

Backend-и PHP пурра нест карда шуд ва аз сифр дар **Node.js** сохта шуд.

```text
JovidxonChat\
  Android\JovidxonChat\   барномаи Android (Kotlin + Compose) — дар компютер, ба GitHub намеравад
  Backend\                сервер: Node.js + Fastify + WebSocket + PostgreSQL
  admin_panel\            панели админ: React (дар /admin/-и ҳамон сервер)
  render.yaml             Blueprint: сервер + база дар Render
```

| Соҳа | Ҳозира |
| --- | --- |
| База | **PostgreSQL** — ҳама чиз дар база: корбарон, паёмҳо, **файлҳои медиа**, танзимот, SMS log, **пароли админ** (hash). Дар диски сервер ҳеҷ чиз нигоҳ дошта намешавад |
| Realtime | **WebSocket** мисли WhatsApp: паём фавран, ✓ фиристода → ✓✓ расид → ✓✓ хонда шуд, «менависад…», онлайн/охирин бор, зангҳо |
| Медиа | **сифати аслии камера**: сурат ва видео фишурда намешаванд (танҳо EXIF/GPS бе талафот тоза мешавад); дар барнома пешфарз «Аслӣ» |
| Панели админ | React: омор, корбарон (блок/нест), гурӯҳҳо, шикоятҳо, SMS log ва санҷиш, **танзимот** (SMS, Google, лимитҳо, реҷаи хизматӣ), админҳо ва нақшҳо, 2FA, журнали аудит, система |
| Воридшавӣ | OTP (AlifTech, захира — SMS Gate) + Google; токенҳо бо ротатсия ва муайянкунии дуздӣ |
| Санҷиш | Backend **53/53** тест, Android **50/50** тест — ҳама гузашт |

Шакли API ҳамон аст — барномаи Android танҳо суроғаи нав ва пайвасти WebSocket гирифт.

---

## 1. Он чи лозим аст

* Репозиторийи **GitHub**: [`jovidxondev-create/JovidxonChat`](https://github.com/jovidxondev-create/JovidxonChat) ва **Git** дар компютер.
* Ҳисоби **[Render](https://render.com)** (бо GitHub ворид шавед).
* Файли **`Backend/.env.render`** — дар компютери шумо тайёр аст: калидҳои AlifTech ва SMS Gate аз `.env`-и пешина.
  Ин файл ба git **намеравад** (`.gitignore`); ба касе нафиристед.

Ҳамаи қиматҳои дигар аллакай дар `render.yaml` ҳастанд: Google Web client ID, SMS (`alif` + захираи `smsgate`,
фиристанда «Olami Ashyo»), минтақаи **Frankfurt** (наздиктарин ба Тоҷикистон), калиди `APP_SECRET` ва рамзи насби
админ (Render худаш тасодуфӣ месозад).

---

## 2. Код дар GitHub

Дар [`github.com/jovidxondev-create/JovidxonChat`](https://github.com/jovidxondev-create/JovidxonChat) (шохаи `main`):
`Backend/`, `admin_panel/`, `render.yaml`, `setup.md`, `README.md`. Барномаи Android, `.env.render`, `*.zip` ва
`node_modules/` ба GitHub **намераванд** (`.gitignore`).

> ⚠️ Файлҳои `JovidxonChat.zip` ва `Backend/.env.render`-ро ҳеҷ гоҳ дастӣ ба GitHub (Add file → Upload) бор накунед —
> дар онҳо калидҳои SMS ҳастанд. Репозиторийро **Private** кунед: GitHub → *Settings* → *General* → *Danger Zone* →
> **Change visibility** → Private (Render бо репозиторийи private ҳам кор мекунад).

Навсозии минбаъда (баъди тағйири код):
```bash
cd C:/Users/Jovidxon-Dev/Desktop/APP/JovidxonChat
```
```bash
git add Backend admin_panel render.yaml setup.md
```
```bash
git commit -m "Тавсифи тағйирот"
```
```bash
git push
```
Render баъди `push` худкор deploy мекунад.

---

## 3. Render: база ва сервер

Сервер базаро аз тағйирёбандаи **`DATABASE_URL`** мегирад. Ҷадвалҳоро худаш месозад — дар база ягон кори дастӣ
(SQL, import) лозим нест. Ду роҳ ҳаст; **Роҳи А** осонтар аст.

### Роҳи А — Blueprint (база худкор сохта ва пайваст мешавад)

1. [dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint**.
2. GitHub-ро пайваст кунед ва репозиторийи **`JovidxonChat`**-ро интихоб кунед. Render `render.yaml`-ро мехонад ва нишон медиҳад:
   * **jovidxon-db** — PostgreSQL 17 (Free, Frankfurt) — **база**
   * **jovidxon-chat** — Web Service (Node, Free, Frankfurt) — сервер
3. Render 4 қимати махфиро мепурсад — аз `Backend/.env.render` нусха кунед:
   `SMS_ALIF_API_KEY`, `SMS_GATE_USER`, `SMS_GATE_PASSWORD`, `SMS_GATE_DEVICE_ID`.
4. **Deploy Blueprint** (ё *Apply*). Аввал база сохта мешавад, баъд сервер (build ~3–6 дақиқа).
   `DATABASE_URL`-и сервер **худкор** ба суроғаи дохилии ҳамин база гузошта мешавад.
5. Дар саҳифаи **jovidxon-chat** суроғаро бинед: `https://jovidxon-chat.onrender.com`.
   Агар ин ном банд бошад, Render пасванд илова мекунад (масалан `jovidxon-chat-ab12.onrender.com`) — он гоҳ қисми 6.

### Роҳи Б — дастӣ: аввал база, баъд сервер

**1. Сохтани база:** **New +** → **Postgres**:

| Майдон | Қимат |
| --- | --- |
| Name | `jovidxon-db` |
| Database | `jovidxon` (баъдтар иваз намешавад) |
| User | `jovidxon` (баъдтар иваз намешавад) |
| Region | **Frankfurt (EU Central)** — ҳатман ҳамон минтақае, ки сервер дар он аст |
| PostgreSQL Version | **17** |
| Plan | Free (ё пулакӣ, қисми 9) |

**Create Database** → 1–3 дақиқа сабр кунед, то ҳолат **Available** шавад.

**2. Суроғаи база:** саҳифаи **jovidxon-db** → тугмаи **Connect** (болои рост) ё **Info** → **Internal Database URL** → нусха
(`postgresql://jovidxon:…@dpg-…-a/jovidxon`). Ин суроға махфӣ аст (пароль дорад).

**3. Сохтани сервер:** **New +** → **Web Service** → репозиторийи `JovidxonChat`:

| Майдон | Қимат |
| --- | --- |
| Name | `jovidxon-chat` |
| Region | **Frankfurt** (ҳамон минтақаи база!) |
| Branch | `main` · Root Directory — холӣ |
| Runtime | Node |
| Build Command | `cd Backend && npm ci --omit=dev && cd ../admin_panel && npm ci --include=dev && npm run build` |
| Start Command | `node Backend/src/server.js` |
| Instance Type | Free |
| Health Check Path (*Advanced*) | `/api/v1/health` |

**4. Environment Variables** (ҳамон ҷо ё баъдтар **Environment**):

| Key | Value |
| --- | --- |
| `DATABASE_URL` | **Internal Database URL** аз қадами 2 — пайвасти база маҳз ҳамин аст |
| `APP_SECRET` | сатри тасодуфӣ ≥ 32 аломат (тугмаи **Generate** ё `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) |
| `ADMIN_SETUP_CODE` | сатри тасодуфӣ (**Generate**) — барои қисми 4 |
| `NODE_VERSION` | `24` |
| `NODE_ENV` | `production` |
| `GOOGLE_CLIENT_IDS` | `601976830935-f5rtf3jsipuotff0b5p8g6cl1rcafi0r.apps.googleusercontent.com` |
| `SMS_DRIVER` · `SMS_FALLBACK_DRIVER` · `SMS_ALIF_SENDER` | `alif` · `smsgate` · `Olami Ashyo` |
| `SMS_ALIF_API_KEY`, `SMS_GATE_USER`, `SMS_GATE_PASSWORD`, `SMS_GATE_DEVICE_ID` | аз `Backend/.env.render` |

**Deploy Web Service.** Дар **Logs** бояд `server_started` бошад.

**Муҳим дар бораи пайвасти база:**
* **Internal** URL танҳо вақте кор мекунад, ки база ва сервер дар як минтақа (Frankfurt) ва як workspace бошанд; он тез аст ва SSL намехоҳад.
* **External** URL — танҳо барои пайваст аз компютери худ (DBeaver, `pg_dump`); SSL ҳатмист. Агар бо он сервери Node-ро
  дар компютер оғоз кунед ва хатои `self-signed certificate` ояд — `DATABASE_SSL=no-verify` гузоред.
* Хатои `ECONNREFUSED`, `ENOTFOUND` ё `startup_failed` дар Logs — одатан минтақаҳо гуногунанд ё External/Internal омехта шудааст.

**Санҷиш** (дар браузер):
* `https://jovidxon-chat.onrender.com/api/v1/health` → `"status":"ok"`
* `https://jovidxon-chat.onrender.com/api/v1/health/ready` → `"status":"ready"`, `database/schema/realtime: true`

Ҷадвалҳои база ҳангоми аввалин оғоз **худкор** сохта мешаванд (миграцияҳо) — phpMyAdmin, import ва cron лозим нестанд.
Логҳо: Render → jovidxon-chat → **Logs**.

---

## 4. Панели админ — аввалин вуруд

1. Render → **jovidxon-chat** → **Environment** → `ADMIN_SETUP_CODE` → нишон додан (👁) → нусха.
2. Кушоед: **`https://jovidxon-chat.onrender.com/admin/`** → саҳифаи «Сохтани админи аввал»:
   рамзи насб, номи корбар (лотинӣ), ном ва **пароли қавӣ** (≥ 10 аломат, набояд номи корбарро дар бар гирад).
3. Шумо **super_admin** ҳастед. Тавсия: **Профили ман → Аутентификатсияи дуқадама (2FA)** (Google Authenticator) фаъол кунед.
4. Админҳои дигар: **Админҳо** → нақшҳо: *support* (дидан), *moderator* (блок, шикоятҳо, SMS log), *super_admin* (ҳама).

Пароли админ **танҳо дар PostgreSQL** (ҳамчун hash-и scrypt) нигоҳ дошта мешавад — на дар файл ва на дар Render.
Рамзи насб баъди сохтани админи аввал дигар кор намекунад. Пароль фаромӯш шуд → қисми 10.

---

## 5. Танзимот аз панели админ (бе deploy)

**Панел → Танзимот.** Қиматҳое, ки дар панел сабт мекунед, дар база нигоҳ дошта мешаванд ва аз `render.yaml`/Environment
муҳимтаранд; фавран амал мекунанд. Калидҳои махфӣ дар база бо AES-256-GCM рамзгузорӣ шудаанд ва пурра нишон дода намешаванд.

| Гурӯҳ | Чӣ |
| --- | --- |
| Умумӣ | бақайдгирии корбарони нав (фаъол/хомӯш), **реҷаи хизматӣ** |
| SMS ва OTP | драйвери асосӣ ва эҳтиётӣ (`alif`, `smsgate`), калидҳо, номи фиристанда, **рақамҳои тестӣ** |
| Воридшавӣ (Google) | Google client ID-ҳо |
| Медиа | ҳадди андоза: сурат 30 MB, видео 100 MB, овоз 16 MB, ҳуҷҷат 100 MB; квотаи корбар |
| Чат | мӯҳлати таҳрири паём, ҳадди аъзои гурӯҳ, мӯҳлати story |
| Зангҳо (WebRTC) | STUN/TURN (барои зангҳо дар шабакаҳои мобилӣ TURN лозим аст) |
| Push (FCM) | JSON-и service account-и Firebase (қисми 8) |

**Санҷиши SMS:** Панел → **SMS** → «Санҷиши SMS» → рақами худ. Ҳар SMS (бе рамз) бо натиҷа ва хато дар ҳамин ҷо сабт мешавад.

---

## 6. Android

`Android/JovidxonChat/gradle.properties` аллакай омода аст:
```properties
jovidxon.apiBaseUrl=https://jovidxon-chat.onrender.com/
jovidxon.googleWebClientId=601976830935-f5rtf3jsipuotff0b5p8g6cl1rcafi0r.apps.googleusercontent.com
```
Агар суроғаи Render дигар бошад — `apiBaseUrl`-ро иваз кунед (бо `/` дар охир) ва APK-ро аз нав созед:
```bash
cd Android/JovidxonChat && ./gradlew :app:assembleDebug
```
APK: `Android/JovidxonChat/app/build/outputs/apk/debug/app-debug.apk`.

* Release танҳо бо HTTPS сохта мешавад (Render HTTPS-и ройгон медиҳад).
* Санҷиш бо сервери компютер (эмулятор): `./gradlew :app:installDebug -Pjovidxon.apiBaseUrlDebug=http://10.0.2.2:8080/`
  (сервер: `Backend/README.md`).
* **Сифати медиа:** Танзимот → Сӯҳбатҳо → Сифати медиа = **Аслӣ** (пешфарз). Сурат айнан ҳамон тавре, ки камера гирифт, меравад;
  HEIC ба JPEG q95 бо ҳамон андоза табдил меёбад. Видео бе фишурдан, бо постер ва андоза.
* Ҳангоми кушода будани барнома пайвасти WebSocket фаъол аст; 15 сония баъди пӯшидан баста мешавад.

---

## 7. Google Sign-In

Дар Render сервер ба интернет баромада метавонад, бинобар ин хатои пешина («Не удалось войти через Google» — AwardSpace
пайвасти беруниро мебаст) дигар нест. Web client ID дар ҳарду ҷо аллакай ҳаст (`render.yaml` ва `gradle.properties`).
Дар [Google Cloud Console](https://console.cloud.google.com) (лоиҳаи `601976830935`) бояд инҳо бошанд:

1. **Google Auth Platform → Audience:** *External*; Gmail-ҳои санҷишӣ дар **Test users** (ё **Publish app** барои ҳама).
2. **Clients → Android:** package `com.jovidxon.chat`, SHA-1-и калиди имзои APK:
   `74:59:CB:E7:FD:AD:23:53:89:BA:A7:92:5C:E5:93:30:6D:2D:5B:02` (калиди debug-и ҳамин компютер).
3. **Clients → Web application** — ҳамон ки ID-аш дар боло аст. *Client secret* лозим нест.

Release / Google Play: барои калиди release ва **Play App Signing** (Play Console → *App integrity* → SHA-1) Android client-ҳои
алоҳида созед (`./gradlew signingReport` ё `keytool -list -v -keystore <файл.jks>`).

| Аломат дар Android | Render → Logs | Сабаб |
| --- | --- | --- |
| «Воридшавӣ бо Google … танзим нашудааст» | — | APK бе `googleWebClientId` ё дар панел Google client ID холист |
| «Вуруд бо Google иҷро нашуд» | дархост нест | Android client нест ё package/SHA-1 дигар; Gmail дар *Test users* нест |
| «Вуруд бо Google иҷро нашуд» | `google_jwks_fetch_failed` | сервер ба `googleapis.com` нарасид (муваққатӣ — такрор кунед) |
| «Воридшавӣ бо Google ноком шуд» | `google_claims_rejected` | client ID-и сервер бо `jovidxon.googleWebClientId` баробар нест |

---

## 8. Push (FCM) — қадами навбатӣ

Сервер омода аст (FCM HTTP v1): Firebase Console → Project settings → Service accounts → **Generate new private key** →
мундариҷаи JSON-ро ба **Панел → Танзимот → Push** гузоред. Қисми Android (`google-services.json`,
`FirebaseMessagingService`) ҳанӯз илова нашудааст — бе он огоҳиҳо танҳо вақте меоянд, ки барнома кушода аст (WebSocket).
Барои ин лоиҳаи Firebase бо package `com.jovidxon.chat` лозим аст.

---

## 9. Маҳдудиятҳои нақшаи ройгон — ҲАТМАН хонед

| Чиз | Free | Оқибат |
| --- | --- | --- |
| Web service | баъди **15 дақиқа** бе дархост/паёми WebSocket «хоб» меравад; бедоршавӣ **~1 дақиқа** | дархости аввали баъди танаффус суст; барнома худаш такрор мекунад |
| Соатҳо | 750 соат/моҳ дар workspace | барои як сервер кофист |
| PostgreSQL | **1 GB**; **30 рӯз баъди сохтан мӯҳлаташ мегузарад**, 14 рӯз барои upgrade, **баъд база нест мешавад**; backup нест | ҳамаи паёмҳо ва медиа гум мешаванд! |

Медиа дар база аст ва бо сифати аслӣ (сурат 3–8 MB) 1 GB зуд пур мешавад. **Барои корбарони воқеӣ** то рӯзи 30-юм:
* **jovidxon-db** → **Upgrade** → нақшаи пулакӣ (аз ~$6/моҳ) ва ҳаҷми диск (~$0.30 барои 1 GB дар як моҳ) — маълумот мемонад;
* **jovidxon-chat** → **Upgrade** → *Starter* (~$7/моҳ) — хоб намеравад, WebSocket доимо фаъол.

Нархҳои дақиқ: [render.com/pricing](https://render.com/pricing). Баъди upgrade дар `render.yaml` ҳам `plan:`-ро иваз кунед.

---

## 10. Нигоҳдорӣ

**Навсозӣ:** `git push` → Render худкор deploy мекунад (танҳо вақте ки `Backend/` ё `admin_panel/` тағйир ёфт).
Миграцияҳои нав ҳангоми оғоз худкор иҷро мешаванд. Барои кори калон: Панел → Танзимот → Умумӣ → **Реҷаи хизматӣ** (API 503 медиҳад,
панели админ кор мекунад).

**Пароли админ фаромӯш шуд** (Render-и ройгон Shell надорад):
1. Render → jovidxon-chat → Environment → **Add** → `ADMIN_RESET` = `номи_корбар:ПаролиНав-2026` (≥ 10 аломат) → **Save** (deploy мешавад).
2. Бо пароли нав ворид шавед (қулф ва 2FA пок, ҳамаи сессияҳои он админ бекор шуданд).
3. **`ADMIN_RESET`-ро фавран нест кунед.**

**Backup-и дастӣ** (нақшаи ройгон backup надорад): jovidxon-db → **Networking** → IP-и худро илова кунед → *External Database URL* →
```bash
pg_dump "<External Database URL>" -Fc -f jovidxon-backup.dump
```
(`pg_dump` аз PostgreSQL 17 client tools.) Баъд IP-ро аз рӯйхат хориҷ кунед.

**Ҳеҷ гоҳ** `APP_SECRET`-ро иваз накунед: ҳамаи корбарон аз система мебароянд ва калидҳои SMS/FCM-и сабтшуда хонда намешаванд.

---

## 11. Амният — checklist

- [ ] Репозиторийи GitHub **private** аст; `.env`, `.env.render`, `*.zip` дар он нестанд
- [ ] Дар Render ва GitHub 2FA фаъол аст
- [ ] Админи аввал сохта шуд, 2FA фаъол; `ADMIN_RESET` дар Environment нест
- [ ] `OTP_TEST_NUMBERS` холӣ (ё рамзҳои душвор, танҳо барои баррасии Google Play)
- [ ] `JovidxonChat.zip` ва ҳар нусхаи кӯҳнаи `.env` калидҳоро доранд — ба касе нафиристед ва ба GitHub бор накунед
- [ ] Агар калиди AlifTech ё пароли SMS Gate ҷое ошкор шуда бошад — онҳоро дар худи хидмат иваз ва дар Панел → Танзимот нав кунед
- [ ] То рӯзи 30-юм база ба нақшаи пулакӣ гузаронида шуд (қисми 9)

---

## 12. Хатогиҳои маъмул

| Аломат | Сабаб | Ҳал |
| --- | --- | --- |
| Build: `npm ci` хато | `package-lock.json` бо `package.json` мувофиқ нест | дар компютер `npm install` (дар ҳамон папка), lockfile-ро commit кунед |
| Logs: `config_invalid` | `DATABASE_URL` ё `APP_SECRET` нест | Blueprint-ро аз нав *Sync* кунед; Environment-ро санҷед |
| Logs: `startup_failed` | база ҳанӯз тайёр нест ё мӯҳлаташ гузашт | jovidxon-db → ҳолат *Available*; баъд **Manual Deploy** |
| Android: «Нет соединения» | суроғаи APK нодуруст ё сервер бедор мешавад | `apiBaseUrl` = суроғаи Render; ~1 дақиқа сабр (қисми 9) |
| «Сервер временно недоступен» баъди рақам | `SMS_SEND_FAILED` | Панел → **SMS**: `http_401/403` — калид/фиристанда; `http_400/402` — формат/баланс; `timeout`, `network_*` — шабака; `smsgate` — телефони SMS Gate хомӯш |
| SMS аз AlifTech намеояд, аммо дигар хато нест | AlifTech IP-и серверро маҳдуд мекунад | ба AlifTech IP-ҳои баромади Render-ро диҳед (jovidxon-chat → **Connect → Outbound**) |
| Ҳама 503 `MAINTENANCE` | реҷаи хизматӣ фаъол | Панел → Танзимот → реҷаи хизматӣ хомӯш |
| Паёмҳо фавран намеоянд | WebSocket пайваст нест | Панел → **Система**: «LISTEN/NOTIFY» ✓ ва шумораи пайвастҳо; барнома бо polling (30–60 с) кор мекунад |
| Система: «IP-и мизоҷ (прокси)» сурх | IP-и мизоҷ дуруст муайян намешавад → rate limit барои ҳама якҷоя | Environment → `TRUST_PROXY` (пешфарз `render`); ба барномасоз гӯед |
| Upload → 413 | файл аз ҳад калон | Панел → Танзимот → Медиа |
| Logs: `database_locale_not_unicode` | locale-и база UTF-8 нест | ҷустуҷӯи кириллица ба ҳарфи калон/хурд ҳассос мешавад; базаи Render одатан дуруст аст |

Логҳо (Render → Logs) JSON мебошанд; дар онҳо **ҳеҷ гоҳ** рамзи OTP, токен, пароль, матни паём ё рақами пурраи телефон нест.

---

Манбаъҳо: [Render Blueprint spec](https://render.com/docs/blueprint-spec) · [Render Free](https://render.com/docs/free) ·
[Нархҳои Render](https://render.com/pricing)
