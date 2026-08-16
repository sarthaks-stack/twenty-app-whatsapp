import { useCopy } from '../common/copy';
import { useFeed } from '../common/use-feed';
import { useInboundToasts } from './use-inbound-toasts';

/**
 * D-10 layer 2, as a mountable piece.
 *
 * It renders nothing and exists only to poll `mine` and call `enqueueSnackbar`.
 * Two things mount it: the `wa-inbox-toaster` front component (so an operator
 * can place it on any page they like) and the inbox itself.
 *
 * **The inbox mounts it directly rather than through a widget**, because a
 * headless front component is not headless in a page layout: the platform still
 * draws the widget frame around it, so the Inbox page carried an empty card
 * titled "Notifications" under the conversation list. A notification surface
 * whose only visible output is a blank box is worse than no surface.
 *
 * **It polls separately from the list, and that is deliberate.** Sharing the
 * inbox's stream would tie the toast to whatever filter the rep last clicked —
 * choose "All" and you would be toasted about other people's conversations;
 * choose "Closed" and you would be toasted about nothing. This asks for `mine`,
 * always, and asks slowly: fifteen seconds, against the inbox's eight.
 */
export const InboundToaster = () => {
  const { t } = useCopy();

  const feed = useFeed({ scope: 'inbox', filter: 'mine', intervalMs: 15_000 });

  useInboundToasts(feed.data?.threads, t);

  return null;
};
