/**
 * Stripe errors: one Error class carrying the HTTP status and the `error` envelope fields, plus
 * helpers for every error the server raises. Message texts are not a contract (docs.stripe.com/api-versions);
 * clients should match on type, code and param (README, "Uncertain behaviour").
 */

export class StripeError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {object} fields `error` fields: type, message, code?, param?, decline_code?, charge?, ...
   * @param {object} [options]
   * @param {object} [options.headers] extra response headers
   * @param {boolean} [options.validation] true for request-validation errors: never saved by the
   *   idempotency layer (docs.stripe.com/api/idempotent_requests)
   */
  constructor(status, fields, { headers = {}, validation = false } = {}) {
    super(fields.message);
    this.name = 'StripeError';
    this.status = status;
    this.fields = fields;
    this.headers = headers;
    this.validation = validation;
  }

  get type() {
    return this.fields.type;
  }

  get code() {
    return this.fields.code;
  }

  get param() {
    return this.fields.param;
  }

  /** The response body: keys sorted, null fields omitted, doc_url and request_log_url added. */
  toBody(requestId) {
    const f = { ...this.fields };
    if (f.code && !f.doc_url) f.doc_url = `https://docs.stripe.com/error-codes#${f.code.replace(/_/g, '-')}`;
    if (requestId && !f.request_log_url) f.request_log_url = `https://dashboard.stripe.com/test/logs/${requestId}`;
    const error = {};
    for (const key of Object.keys(f).sort()) {
      if (f[key] !== null && f[key] !== undefined) error[key] = f[key];
    }
    return { error };
  }
}

/** Error codes that mean "the request failed validation": never saved for idempotent replay. */
const VALIDATION_CODES = /^(parameter_|parameters_exclusive$)/;

/** 400 invalid_request_error. `status` may be overridden (e.g. 404). */
export function invalidRequest(message, { param, code, status = 400, validation, headers } = {}) {
  const isValidation = validation ?? Boolean(code && VALIDATION_CODES.test(code));
  return new StripeError(status, { type: 'invalid_request_error', message, code, param }, { validation: isValidation, headers });
}

/**
 * resource_missing: 404 with param "id" for an ID in the URL path, 400 with the bracketed param
 * for an ID in the body or query. `noun` is the object's `object` value, e.g. "customer".
 */
export function resourceMissing(noun, id, { param = 'id', status } = {}) {
  return invalidRequest(`No such ${noun}: '${id}'`, {
    param,
    code: 'resource_missing',
    status: status ?? (param === 'id' ? 404 : 400),
    validation: false,
  });
}

export function parameterMissing(param) {
  return invalidRequest(`Missing required param: ${param}.`, { param, code: 'parameter_missing' });
}

export function parameterUnknown(param) {
  return invalidRequest(`Received unknown parameter: ${param}`, { param, code: 'parameter_unknown' });
}

/** parameters_exclusive; `param` defaults to the last of the conflicting names. */
export function parametersExclusive(params, { param } = {}) {
  return invalidRequest(`You may only specify one of these parameters: ${params.join(', ')}.`, {
    param: param ?? params[params.length - 1],
    code: 'parameters_exclusive',
  });
}

export function invalidEmpty(param) {
  return invalidRequest(
    `You passed an empty string for '${param}'. We assume empty values are an attempt to unset a parameter; however '${param}' cannot be unset. You should remove '${param}' from your request or supply a non-empty value.`,
    { param, code: 'parameter_invalid_empty' },
  );
}

export function invalidInteger(param, value) {
  return invalidRequest(`Invalid integer: ${value}`, { param, code: 'parameter_invalid_integer' });
}

/** A validation error without a documented code (bad enum, bad boolean, too long, ...). */
export function invalidParam(param, message) {
  return invalidRequest(message, { param, validation: true });
}

/**
 * 402 card_error (docs.stripe.com/testing). Pass the rendered PaymentIntent / PaymentMethod objects
 * when the error should carry them (the docs type both as objects).
 */
export function cardError({
  code = 'card_declined',
  declineCode,
  message = 'Your card was declined.',
  param,
  charge,
  paymentIntent,
  paymentMethod,
  adviceCode,
} = {}) {
  return new StripeError(402, {
    type: 'card_error',
    code,
    decline_code: declineCode,
    message,
    param,
    charge,
    payment_intent: paymentIntent,
    payment_method: paymentMethod,
    advice_code: adviceCode,
  });
}

/** 400 idempotency_error. */
export function idempotencyError(message) {
  return new StripeError(400, { type: 'idempotency_error', message }, { validation: true });
}

/** 5xx api_error. */
export function apiError(message = "Something went wrong on Stripe's end.", status = 500, headers = {}) {
  return new StripeError(status, { type: 'api_error', message }, { headers });
}

/** 429 rate limit (docs.stripe.com/rate-limits): code rate_limit and a Stripe-Rate-Limited-Reason header. */
export function rateLimitError(reason = 'global-rate') {
  return new StripeError(
    429,
    {
      type: 'invalid_request_error',
      code: 'rate_limit',
      message: 'Too many requests hit the API too quickly. We recommend an exponential backoff of your requests.',
    },
    { headers: { 'Stripe-Rate-Limited-Reason': reason }, validation: true },
  );
}

/** 401 authentication error: type invalid_request_error. */
export function authenticationError(message, code) {
  return new StripeError(401, { type: 'invalid_request_error', message, code }, { validation: true });
}

/** 404 for a URL no route matches ("Unrecognized request URL"). */
export function unrecognizedUrl(method, path) {
  return invalidRequest(
    `Unrecognized request URL (${method}: ${path}). Please see https://stripe.com/docs or we can help at https://support.stripe.com/.`,
    { status: 404, validation: true },
  );
}

/**
 * Wraps any thrown value into a StripeError. Unknown exceptions become a 500 api_error with
 * Stripe-Should-Retry: false (a retry would only replay it; the SDK honours the header).
 */
export function toStripeError(err) {
  if (err instanceof StripeError) return err;
  return apiError(`An unexpected error occurred: ${err && err.message ? err.message : String(err)}`, 500, { 'Stripe-Should-Retry': 'false' });
}
