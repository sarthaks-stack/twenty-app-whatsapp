import { defineFrontComponent } from 'twenty-sdk/define';

import { InboxView } from '../components/inbox/InboxView';
import { FC_INBOX } from '../constants/universal-identifiers';

/**
 * The WhatsApp inbox, as a page of its own (FR-UI-2).
 *
 * Surfaced by a standalone page layout and a navigation item rather than by a
 * record page: an inbox is not *about* a record, and putting it on one would
 * mean choosing whose record the workspace's shared queue belongs to.
 */
const WaInbox = () => <InboxView />;

export default defineFrontComponent({
  universalIdentifier: FC_INBOX,
  name: 'wa-inbox',
  description: 'Every WhatsApp conversation, filterable, with the chat beside it.',
  component: WaInbox,
});
