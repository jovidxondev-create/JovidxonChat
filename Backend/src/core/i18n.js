/**
 * Матнҳои кам, ки сервер худаш месозад (SMS, push, номи ҳисоби нестшуда, саҳифаи даъват).
 * Ҳамаи матнҳои UI дар Android (strings.xml) ва панели админ ҳастанд.
 */
const STRINGS = {
  tk: {
    otp_sms: 'JovidxonChat: рамзи воридшавӣ :code. Ба касе нагӯед.',
    deleted_account: 'Ҳисоби нестшуда',
    default_name: 'Корбар :suffix',
    push_photo: '📷 Сурат',
    push_video: '🎬 Видео',
    push_voice: '🎤 Паёми овозӣ',
    push_document: '📄 Ҳуҷҷат',
    push_new_message: 'Паёми нав',
    invite_title: 'Даъват ба гурӯҳ',
    invite_body: 'Барномаи JovidxonChat-ро кушоед ва ин рамзро дар «Пайвастшавӣ ба гурӯҳ» ворид кунед:',
    sms_test: 'JovidxonChat: санҷиши SMS. Агар ин паёмро гирифтед, SMS кор мекунад.',
  },
  ru: {
    otp_sms: 'JovidxonChat: код входа :code. Никому не сообщайте.',
    deleted_account: 'Удалённый аккаунт',
    default_name: 'Пользователь :suffix',
    push_photo: '📷 Фото',
    push_video: '🎬 Видео',
    push_voice: '🎤 Голосовое сообщение',
    push_document: '📄 Документ',
    push_new_message: 'Новое сообщение',
    invite_title: 'Приглашение в группу',
    invite_body: 'Откройте JovidxonChat и введите этот код в разделе «Вступить в группу»:',
    sms_test: 'JovidxonChat: проверка SMS. Если вы получили это сообщение, SMS работает.',
  },
};

export function normalizeLocale(value) {
  const v = String(value ?? '').toLowerCase();
  return v.startsWith('ru') ? 'ru' : 'tk';
}

export function t(key, locale, replace = {}) {
  const lang = normalizeLocale(locale);
  let text = STRINGS[lang][key] ?? STRINGS.tk[key] ?? key;
  for (const [name, value] of Object.entries(replace)) text = text.replaceAll(`:${name}`, String(value));
  return text;
}

/** Номи пешфарзи корбари нав — барои муайян кардани профили нимтамом. */
export const DEFAULT_NAME_RE = /^(Корбар|Пользователь) \d{4}$/u;
