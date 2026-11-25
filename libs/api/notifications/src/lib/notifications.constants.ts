/**
 * Upper bound on rows the unread list returns. The endpoint is unpaginated and
 * polled, and there is no unread-pruning, so a dormant account can accumulate
 * thousands of unread rows; without a cap every poll would fetch all of them.
 * 100 most-recent is plenty for a notification tray.
 *
 * Also the most ids one mark-read names: a client marks what the tray showed
 * it, and the cap keeps each call's id list, and its IN filter, bounded (#584).
 */
export const MAX_UNREAD_NOTIFICATIONS = 100;
