import { defineFrontComponent } from 'twenty-sdk/define';

import { InboundToaster } from '../components/inbox/InboundToaster';
import { FC_INBOX_TOASTER } from '../constants/universal-identifiers';

/**
 * D-10 layer 2 — the live toast (FR-IN-5, re-specified).
 *
 * Headless: it renders nothing and exists only to poll and call
 * `enqueueSnackbar`. The behaviour lives in `<InboundToaster>` so that the
 * inbox can mount it directly — see that file for why the Inbox page no longer
 * carries this as a widget.
 *
 * It stays registered because `isHeadless` makes it placeable on any page an
 * operator chooses: a rep watching a campaign should still be told when one of
 * their conversations answers.
 *
 * What it cannot do is reach anyone whose tab is closed. That is layer 3's job
 * — a `whatsappMessage.created` workflow the operator configures — and claiming
 * otherwise would make this the kind of notification system that quietly does
 * not notify.
 */
export default defineFrontComponent({
  universalIdentifier: FC_INBOX_TOASTER,
  name: 'wa-inbox-toaster',
  description: 'Raises a toast when a conversation assigned to you receives a message.',
  isHeadless: true,
  component: InboundToaster,
});
