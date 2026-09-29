import { Keys } from '../core/crypto.js';
import { RateLimiter } from '../core/ratelimit.js';
import { Account } from './account.js';
import { Admin } from './admin.js';
import { Auth } from './auth.js';
import { Calls } from './calls.js';
import { Chats } from './chats.js';
import { Devices } from './devices.js';
import { GoogleVerifier } from './google.js';
import { Groups } from './groups.js';
import { Maintenance } from './maintenance.js';
import { Media } from './media/index.js';
import { Push } from './push.js';
import { Bus, Hub } from './realtime.js';
import { Safety } from './safety.js';
import { Settings } from './settings.js';
import { SmsService } from './sms.js';
import { Stories } from './stories.js';
import { Users } from './users.js';

/** Контейнери хидматҳо. Хидматҳо ҳамдигарро тавассути ctx (дар вақти даъват) мегиранд. */
export function createContext({ config, db, log }) {
  const ctx = { config, db, log, diagnostics: {} };
  ctx.keys = new Keys(config.appSecret);
  ctx.settings = new Settings({ db, keys: ctx.keys, config, log });
  ctx.limiter = new RateLimiter({
    db,
    keys: ctx.keys,
    multiplier: Number.parseInt(process.env.RATE_LIMIT_MULTIPLIER ?? '1', 10) || 1,
    log,
  });
  ctx.bus = new Bus({ db, log });
  ctx.users = new Users({ db });
  ctx.devices = new Devices({ db });
  ctx.sms = new SmsService({ db, settings: ctx.settings, config, log });
  ctx.google = new GoogleVerifier({ log });
  ctx.auth = new Auth({
    db,
    keys: ctx.keys,
    config,
    settings: ctx.settings,
    users: ctx.users,
    devices: ctx.devices,
    sms: ctx.sms,
    limiter: ctx.limiter,
    google: ctx.google,
    bus: ctx.bus,
    log,
  });
  ctx.chats = new Chats(ctx);
  ctx.groups = new Groups(ctx);
  ctx.safety = new Safety(ctx);
  ctx.media = new Media(ctx);
  ctx.stories = new Stories(ctx);
  ctx.calls = new Calls(ctx);
  ctx.push = new Push(ctx);
  ctx.account = new Account(ctx);
  ctx.hub = new Hub(ctx);
  ctx.admin = new Admin(ctx);
  ctx.maintenance = new Maintenance(ctx);
  ctx.bus.on((event) => ctx.hub.onEvent(event));
  return ctx;
}
