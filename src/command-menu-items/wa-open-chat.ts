import {
  defineCommandMenuItem,
  numberOfSelectedRecords,
  STANDARD_OBJECT,
} from 'twenty-sdk/define';

import { CMI_OPEN_CHAT, FC_SIDE_PANEL_CHAT } from '../constants/universal-identifiers';

/**
 * "Open WhatsApp chat", from any Person, anywhere (FR-UI-3).
 *
 * The condition is not decoration. `<ThreadView>` takes the first selected id,
 * which is only a meaningful thing to do when there is exactly one — without
 * the guard, a rep who had select-all'd a list and reached for the command menu
 * would be shown one arbitrary contact's private conversation.
 *
 * **It has to be an expression, not a sentence describing one** (D-63). This
 * read `'numberOfSelectedRecords === 1'`, as a string — which type-checks,
 * builds, installs, and then never matches: the platform compiles the
 * expression from the *source* of a real comparison against the SDK's context
 * bindings, and a quoted lookalike is just an opaque string it cannot satisfy.
 * The command was therefore absent from the People command menu in every
 * situation, including the single-selection one it was written for, with
 * nothing anywhere reporting a problem.
 *
 * `numberOfSelectedRecords` is a Proxy that throws if anything reads a property
 * off it at runtime; `===` touches no property, so the comparison is inert
 * outside the compiler and meaningful inside it. That is the shape the SDK
 * intends, and the reason the import is load-bearing rather than cosmetic.
 */
export default defineCommandMenuItem({
  universalIdentifier: CMI_OPEN_CHAT,
  label: 'Open WhatsApp chat',
  shortLabel: 'WhatsApp',
  availabilityType: 'RECORD_SELECTION',
  availabilityObjectUniversalIdentifier: STANDARD_OBJECT.person.universalIdentifier,
  frontComponentUniversalIdentifier: FC_SIDE_PANEL_CHAT,
  conditionalAvailabilityExpression: numberOfSelectedRecords === 1,
});
