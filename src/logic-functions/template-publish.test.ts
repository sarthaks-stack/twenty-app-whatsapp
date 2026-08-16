import { describe, expect, it } from 'vitest';

import { publishRefusal } from './wa-template-submit';

/**
 * Publishing a template (FR-TPL-2).
 *
 * This route arm exists because the flag had no writer. Everything else in the
 * app only ever sets `publishedToCrm` to **false** — sync un-publishes on
 * degradation, the webhook un-publishes on rejection, the sender un-publishes
 * when Meta refuses the mapping — so a template synced from Meta could never
 * become selectable, and the picker was permanently empty. Confirmed live: five
 * approved templates, none publishable, and `create` on a campaign answering
 * "The template has not been published for use in the CRM".
 *
 * The two conditions below are the same ones the send path re-checks. Both
 * failures produce a template that is in the picker and fails at Meta for every
 * recipient, which is the most expensive way to discover either.
 */
describe('publishRefusal', () => {
  const usable = { status: 'APPROVED', isUsableInCrm: true, unsupportedReason: null };

  it('allows an approved, renderable template', () => {
    expect(publishRefusal(usable)).toBeNull();
  });

  it('refuses anything Meta has not approved', () => {
    for (const status of ['PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL']) {
      expect(publishRefusal({ ...usable, status })).toContain(status);
    }
  });

  it('refuses a template the app cannot render, and says which part', () => {
    const refusal = publishRefusal({
      ...usable,
      isUsableInCrm: false,
      unsupportedReason: 'CAROUSEL',
    });

    expect(refusal).toContain('CAROUSEL');
  });

  it('refuses a template whose renderability was never assessed', () => {
    // `isUsableInCrm` absent is not the same as true. A record written before
    // the field existed, or by a sync that failed part-way, must not be
    // publishable on the strength of a missing value.
    expect(publishRefusal({ status: 'APPROVED' })).not.toBeNull();
    expect(publishRefusal({ status: 'APPROVED', isUsableInCrm: null })).not.toBeNull();
  });

  it('refuses a template with no status at all', () => {
    expect(publishRefusal({})).not.toBeNull();
  });
});
