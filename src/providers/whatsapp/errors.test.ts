import { describe, expect, it } from 'vitest';

import {
  ERROR_CATALOG,
  ERROR_CLASS,
  MetaApiError,
  ambiguousError,
  classify,
  fromResponseBody,
  networkError,
} from './errors';

const metaError = (code: number, httpStatus = 400) =>
  fromResponseBody(httpStatus, {
    error: { message: 'boom', code, error_data: { details: 'why' } },
  });

describe('fromResponseBody', () => {
  it('reads the Graph error envelope', () => {
    const error = fromResponseBody(400, {
      error: {
        message: 'Message undeliverable',
        type: 'OAuthException',
        code: 131026,
        error_subcode: 2655007,
        error_data: { details: 'Receiver is incapable of receiving this message' },
      },
    });

    expect(error).toBeInstanceOf(MetaApiError);
    expect(error.code).toBe(131026);
    expect(error.subcode).toBe(2655007);
    expect(error.details).toBe('Receiver is incapable of receiving this message');
    expect(error.httpStatus).toBe(400);
  });

  it('survives a body that is not a Graph error at all', () => {
    const error = fromResponseBody(502, { _unparsed: '<html>Bad gateway</html>' });

    expect(error.code).toBeNull();
    expect(error.httpStatus).toBe(502);
    expect(classify(error).class).toBe(ERROR_CLASS.RETRYABLE_BACKOFF);
  });
});

describe('classify', () => {
  it.each([
    [131047, ERROR_CLASS.TERMINAL_RECIPIENT],
    [131026, ERROR_CLASS.TERMINAL_RECIPIENT],
    [131049, ERROR_CLASS.TERMINAL_RECIPIENT],
    [131053, ERROR_CLASS.RETRYABLE_BACKOFF],
    [131056, ERROR_CLASS.RETRYABLE_BACKOFF],
    [130429, ERROR_CLASS.RETRYABLE_BACKOFF],
    [132000, ERROR_CLASS.TERMINAL_CONTENT],
    [132012, ERROR_CLASS.TERMINAL_CONTENT],
    [190, ERROR_CLASS.RETRYABLE_AFTER_REFRESH],
    [131031, ERROR_CLASS.TERMINAL_UNKNOWN],
    [368, ERROR_CLASS.TERMINAL_UNKNOWN],
  ])('classifies %i', (code, expected) => {
    expect(classify(metaError(code)).class).toBe(expected);
  });

  /**
   * The code is the more specific signal. A 400 carrying 131049 is a recipient
   * outcome, not a bad request — a status-only rule must never shadow it.
   */
  it('prefers the error code over the HTTP status', () => {
    expect(classify(metaError(131049, 400)).class).toBe(ERROR_CLASS.TERMINAL_RECIPIENT);
    expect(classify(metaError(130429, 500)).class).toBe(ERROR_CLASS.RETRYABLE_BACKOFF);
  });

  it.each([
    [401, ERROR_CLASS.RETRYABLE_AFTER_REFRESH],
    [403, ERROR_CLASS.RETRYABLE_AFTER_REFRESH],
    [404, ERROR_CLASS.TERMINAL_UNKNOWN],
    [429, ERROR_CLASS.RETRYABLE_BACKOFF],
    [500, ERROR_CLASS.RETRYABLE_BACKOFF],
    [503, ERROR_CLASS.RETRYABLE_BACKOFF],
  ])('falls back to HTTP %i when the code is unknown', (status, expected) => {
    expect(classify(new MetaApiError('x', { httpStatus: status })).class).toBe(expected);
  });

  /** A non-zero `wa.send.unmapped_error` is the signal appendix B needs a row. */
  it('flags an unmapped code rather than guessing', () => {
    const result = classify(metaError(999999));

    expect(result.class).toBe(ERROR_CLASS.TERMINAL_UNKNOWN);
    expect(result.unmapped).toBe(true);
  });

  it('does not flag a status-matched error as unmapped', () => {
    expect(classify(new MetaApiError('x', { httpStatus: 429 })).unmapped).toBe(false);
  });
});

describe('effects', () => {
  it('marks a per-user marketing cap as a campaign skip, not a failure', () => {
    // Counting it as a failure would trip the circuit breaker on a non-problem.
    expect(classify(metaError(131049)).effect).toEqual({ campaignSkip: true });
  });

  it('pauses the campaign for a template mismatch, because the mapping is wrong for everyone', () => {
    expect(classify(metaError(132000)).effect).toMatchObject({
      pauseCampaign: true,
      unpublishTemplate: true,
    });
  });

  it('alerts on 131047, because the policy gate should have pre-empted it', () => {
    expect(classify(metaError(131047)).effect.alertAdmin).toBe(true);
  });

  it('widens spacing for a pair rate limit', () => {
    expect(classify(metaError(131056)).effect.widenSpacing).toBe(true);
  });

  it('takes the account out of service on a dead token', () => {
    expect(classify(metaError(190)).effect).toMatchObject({
      accountError: true,
      alertAdmin: true,
    });
  });
});

describe('transport failures', () => {
  it('treats a network failure as retryable', () => {
    const error = networkError(new Error('ECONNRESET'));

    expect(classify(error).class).toBe(ERROR_CLASS.RETRYABLE_BACKOFF);
    expect(error.retryable).toBe(true);
  });

  /**
   * A duplicate customer message is worse than a false failure, so an
   * ambiguous outcome is terminal by construction — never retried.
   */
  it('never retries an ambiguous outcome', () => {
    const error = ambiguousError(new Error('AbortError'));

    expect(error.ambiguous).toBe(true);
    expect(classify(error).class).toBe(ERROR_CLASS.TERMINAL_UNKNOWN);
    expect(error.retryable).toBe(false);
  });

  it('keeps ambiguity even when a code would say otherwise', () => {
    const error = new MetaApiError('x', { code: 130429, ambiguous: true });

    expect(classify(error).class).toBe(ERROR_CLASS.TERMINAL_UNKNOWN);
  });
});

describe('the catalogue itself', () => {
  it('covers every code appendix B lists', () => {
    for (const code of [
      131047, 131026, 131049, 131051, 131053, 131056, 130429, 131000, 131008, 131009, 132000,
      132001, 132005, 132007, 132012, 131064, 131031, 368, 100, 190, 200, 10, 299, 80007, 33,
    ]) {
      expect(ERROR_CATALOG.has(code), `missing ${code}`).toBe(true);
    }
  });

  it('gives every entry a class and a meaning', () => {
    for (const entry of ERROR_CATALOG.values()) {
      expect(Object.values(ERROR_CLASS)).toContain(entry.class);
      expect(entry.meaning.length).toBeGreaterThan(0);
    }
  });
});
