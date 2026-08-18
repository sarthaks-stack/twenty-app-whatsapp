import { STANDARD_OBJECT } from 'twenty-sdk/define';
import { describe, expect, it } from 'vitest';

import { PERSON_FIELDS_VIEW_UID, PERSON_OBJECT_UID } from './universal-identifiers';

/**
 * The one duplicated identifier in the app, and why it is duplicated.
 *
 * `twenty-sdk/define` is a *build-time* surface: the logic-function bundler
 * replaces everything imported from it with a stub, so
 * `STANDARD_OBJECT.person.universalIdentifier` is `undefined` inside a running
 * function. Nothing warns — the type checker still says `string`, the bundle
 * builds, the apply succeeds, and the first real call quietly looks up nothing.
 * That is how the campaign builder's view list came back empty with no error
 * anywhere.
 *
 * So the value is written out as a literal for runtime use, and this test is
 * what keeps the copy honest. It runs in Node against the real module, where
 * the stub does not apply.
 */
describe('PERSON_OBJECT_UID', () => {
  it('is exactly what the SDK says, so the runtime copy cannot drift', () => {
    expect(PERSON_OBJECT_UID).toBe(STANDARD_OBJECT.person.universalIdentifier);
  });
});

/** Same duplication, same reason: post-install reads this view at runtime. */
describe('PERSON_FIELDS_VIEW_UID', () => {
  it('is exactly what the SDK says, so the runtime copy cannot drift', () => {
    expect(PERSON_FIELDS_VIEW_UID).toBe(
      STANDARD_OBJECT.person.views.personRecordPageFields.universalIdentifier,
    );
  });
});
