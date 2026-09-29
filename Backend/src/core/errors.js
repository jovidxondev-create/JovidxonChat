/**
 * Каталоги ягонаи хатогиҳо (38). code => [HTTP status, message_key, retryable].
 * message_key-ҳо бо Android (ui/util/ServerErrorMessage.kt) ҳамоҳанганд.
 */
export const ERRORS = Object.freeze({
  VALIDATION_FAILED: [422, 'error_validation_failed', false],
  PAYLOAD_TOO_LARGE: [413, 'error_validation_length', false],

  AUTH_UNAUTHORIZED: [401, 'error_unauthorized', false],
  AUTH_TOKEN_EXPIRED: [401, 'error_session_expired', true],
  AUTH_REFRESH_REVOKED: [401, 'error_session_revoked', false],
  AUTH_OTP_INVALID: [400, 'error_otp_invalid', true],
  AUTH_OTP_EXPIRED: [400, 'error_otp_expired', true],
  AUTH_OTP_COOLDOWN: [429, 'error_otp_cooldown', true],
  AUTH_OTP_RATE_LIMITED: [429, 'error_otp_rate_limited', true],
  AUTH_GOOGLE_INVALID: [401, 'error_google_invalid', false],
  AUTH_GOOGLE_NOT_CONFIGURED: [503, 'error_google_not_configured', false],
  ACCOUNT_SUSPENDED: [403, 'error_account_suspended', false],
  REGISTRATION_CLOSED: [403, 'error_permission_denied', false],
  SMS_SEND_FAILED: [503, 'error_server', true],

  USERNAME_TAKEN: [409, 'error_username_taken', false],
  PHONE_TAKEN: [409, 'error_phone_taken', false],
  PERMISSION_DENIED: [403, 'error_permission_denied', false],
  GROUP_PERMISSION_DENIED: [403, 'error_group_permission', false],
  USER_BLOCKED: [403, 'error_user_blocked', false],
  NOT_FOUND: [404, 'error_not_found', false],
  METHOD_NOT_ALLOWED: [405, 'error_not_found', false],
  CONFLICT_VERSION: [409, 'error_conflict', true],
  RATE_LIMITED: [429, 'error_rate_limited', true],

  MEDIA_TOO_LARGE: [413, 'error_media_too_large', false],
  MEDIA_TYPE_UNSUPPORTED: [415, 'error_media_type', false],
  MEDIA_QUOTA_EXCEEDED: [413, 'error_media_too_large', false],
  UPLOAD_FAILED: [400, 'error_upload_failed', true],

  CALL_UNAVAILABLE: [409, 'error_call_unavailable', true],

  ADMIN_SETUP_DONE: [409, 'error_conflict', false],
  ADMIN_TOTP_REQUIRED: [401, 'error_totp_required', false],
  ADMIN_LOCKED: [429, 'error_rate_limited', true],

  MAINTENANCE: [503, 'error_maintenance', true],
  SERVICE_MISCONFIGURED: [503, 'error_maintenance', true],
  SERVER_ERROR: [500, 'error_server', true],
});

/**
 * Хатои API бо code-и устувор. Матни техникӣ ҳеҷ гоҳ ба клиент намеравад — танҳо code + message_key.
 */
export class ApiError extends Error {
  constructor(code, { messageKey, errors = [], status, headers = {} } = {}) {
    const definition = ERRORS[code] ?? ERRORS.SERVER_ERROR;
    super(code);
    this.name = 'ApiError';
    this.code = ERRORS[code] ? code : 'SERVER_ERROR';
    this.status = status ?? definition[0];
    this.messageKey = messageKey ?? definition[1];
    this.retryable = definition[2];
    this.errors = errors;
    this.headers = headers;
  }

  toBody() {
    return {
      success: false,
      message: this.code,
      data: {},
      errors: this.errors,
      message_key: this.messageKey,
      retryable: this.retryable,
    };
  }
}

/** {field, code: VALIDATION_<RULE>, message_key: error_validation_<rule>} */
export function fieldError(field, rule) {
  return {
    field,
    code: `VALIDATION_${rule.toUpperCase()}`,
    message_key: `error_validation_${rule}`,
  };
}

export const fail = {
  field: (field, rule) => new ApiError('VALIDATION_FAILED', { errors: [fieldError(field, rule)] }),
  validation: (errors) => new ApiError('VALIDATION_FAILED', { errors }),
  notFound: () => new ApiError('NOT_FOUND'),
  forbidden: (messageKey) => new ApiError('PERMISSION_DENIED', { messageKey }),
  groupPermission: () => new ApiError('GROUP_PERMISSION_DENIED'),
  of: (code, options) => new ApiError(code, options),
};
