import { defineFrontComponent } from 'twenty-sdk/define';

import { useCopy } from '../components/common/copy';
import { useFeed } from '../components/common/use-feed';
import { useInboundToasts } from '../components/inbox/use-inbound-toasts';
import { FC_INBOX_TOASTER } from '../constants/universal-identifiers';

/**
 * D-10 layer 2 — the live toast (FR-IN-5, re-specified).
 *
 * Headless: it renders nothing and exists only to poll and call
 * `enqueueSnackbar`. That is the whole reason it is a separate component rather
 * than a hook inside the inbox — a snackbar should keep arriving while a rep is
 * looking at a *campaign*, not only while they are looking at the conversation
 * list, and a headless component can be mounted on any page later without
 * dragging an inbox onto it.
 *
 * **It is a second poll on the Inbox page, and that is deliberate.** Sharing the
 * inbox's stream would tie the toast to whatever filter the rep last clicked —
 * choose "Todas" and you would be toasted about other people's conversations;
 * choose "Fechadas" and you would be toasted about nothing. This asks for
 * `mine`, always, and asks slowly: fifteen seconds, against the inbox's eight.
 *
 * What it cannot do is reach anyone whose tab is closed. That is layer 3's job
 * — a `whatsappMessage.created` workflow the operator configures — and claiming
 * otherwise would make this the kind of notification system that quietly does
 * not notify.
 */
const WaInboxToaster = () => {
  const { t } = useCopy();

  const feed = useFeed({ scope: 'inbox', filter: 'mine', intervalMs: 15_000 });

  useInboundToasts(feed.data?.threads, t);

  return null;
};

export default defineFrontComponent({
  universalIdentifier: FC_INBOX_TOASTER,
  name: 'wa-inbox-toaster',
  description: 'Raises a toast when a conversation assigned to you receives a message.',
  isHeadless: true,
  component: WaInboxToaster,
});
