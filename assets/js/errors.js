/* ==========================================================================
   errors.js — one vocabulary for failures.

   Every layer (backend client, local provider, voice, storage) throws or
   returns TralixError. The UI maps `code` to a human sentence plus whether a
   retry makes sense — never a stack trace.
   ========================================================================== */

export const ERROR_CODES = {
  offline: 'offline',
  network: 'network',
  timeout: 'timeout',
  rate_limit: 'rate_limit',
  unauthorized: 'unauthorized',
  invalid_config: 'invalid_config',
  provider_unavailable: 'provider_unavailable',
  bad_request: 'bad_request',
  too_long: 'too_long',
  aborted: 'aborted',
  unsupported: 'unsupported',
  unknown: 'unknown',
};

const MESSAGES = {
  [ERROR_CODES.offline]: 'You appear to be offline. Reconnect and try again.',
  [ERROR_CODES.network]: 'Unable to connect to TRALIX. Check your connection and try again.',
  [ERROR_CODES.timeout]: 'Request timed out. The answer may be long — try again or shorten the request.',
  [ERROR_CODES.rate_limit]: 'Rate limit reached. Give it a few seconds before sending again.',
  [ERROR_CODES.unauthorized]: 'TRALIX is not authorised to use the AI service. Check the server key.',
  [ERROR_CODES.invalid_config]: 'Invalid configuration. The TRALIX backend is missing or misconfigured.',
  [ERROR_CODES.provider_unavailable]: 'The AI service is unavailable right now. Try again shortly.',
  [ERROR_CODES.bad_request]: 'That request could not be processed. Try rephrasing it.',
  [ERROR_CODES.too_long]: 'That message is too long for TRALIX. Trim it and try again.',
  [ERROR_CODES.aborted]: 'Stopped.',
  [ERROR_CODES.unsupported]: 'That feature is not available yet.',
  [ERROR_CODES.unknown]: 'Something went wrong. Please try again.',
};

const RETRYABLE = new Set([
  ERROR_CODES.network, ERROR_CODES.timeout, ERROR_CODES.rate_limit,
  ERROR_CODES.provider_unavailable, ERROR_CODES.unknown,
]);

export class TralixError extends Error {
  /**
   * @param {string} code    one of ERROR_CODES
   * @param {object} [opts]
   * @param {string} [opts.message]  override the default sentence
   * @param {number} [opts.status]   HTTP status if there was one
   * @param {string} [opts.detail]   technical detail — logs only, never shown
   * @param {boolean}[opts.retryable]
   */
  constructor(code = ERROR_CODES.unknown, { message, status = 0, detail = '', retryable } = {}) {
    super(message || MESSAGES[code] || MESSAGES[ERROR_CODES.unknown]);
    this.name = 'TralixError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.retryable = typeof retryable === 'boolean' ? retryable : RETRYABLE.has(code);
  }

  /** Safe object for logs / debug panel — never rendered into the chat. */
  toDebug() {
    return { code: this.code, status: this.status, detail: this.detail };
  }
}

/** Map any thrown value into a TralixError. */
export function toTralixError(err) {
  if (err instanceof TralixError) return err;
  if (err?.name === 'AbortError') return new TralixError(ERROR_CODES.aborted, { retryable: false });

  const msg = String(err?.message || err || '');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return new TralixError(ERROR_CODES.offline, { detail: msg });
  }
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
    return new TralixError(ERROR_CODES.network, { detail: msg });
  }
  return new TralixError(ERROR_CODES.unknown, { detail: msg, message: msg || undefined });
}

/** HTTP status → code, used by both the backend client and local providers. */
export function codeFromStatus(status, vendorCode = '') {
  if (status === 401 || status === 403) return ERROR_CODES.unauthorized;
  if (status === 404 || status === 400) {
    return /model|not_found/i.test(vendorCode) ? ERROR_CODES.invalid_config : ERROR_CODES.bad_request;
  }
  if (status === 413) return ERROR_CODES.too_long;
  if (status === 429) return ERROR_CODES.rate_limit;
  if (status === 408 || status === 504) return ERROR_CODES.timeout;
  if (status >= 500) return ERROR_CODES.provider_unavailable;
  return ERROR_CODES.unknown;
}

/** Short label used by the status indicator. */
export function errorLabel(code) {
  return {
    [ERROR_CODES.offline]: 'Offline',
    [ERROR_CODES.network]: 'Connection problem',
    [ERROR_CODES.timeout]: 'Timed out',
    [ERROR_CODES.rate_limit]: 'Rate limited',
    [ERROR_CODES.unauthorized]: 'Key rejected',
    [ERROR_CODES.invalid_config]: 'Not configured',
    [ERROR_CODES.provider_unavailable]: 'Service unavailable',
    [ERROR_CODES.bad_request]: 'Request rejected',
    [ERROR_CODES.too_long]: 'Too long',
    [ERROR_CODES.aborted]: 'Stopped',
    [ERROR_CODES.unsupported]: 'Unsupported',
    [ERROR_CODES.unknown]: 'Error',
  }[code] || 'Error';
}
