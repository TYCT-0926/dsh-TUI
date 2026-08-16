import React from 'react';
import type { Channel } from '../dsh-adapter/channel.js';
/**
 * The footer under the prompt input, in Claude Code's PromptInputFooter
 * layout: the segmented context progress bar on its own first line, the
 * status line below (left group: model · tokens · think level · cache · tps
 * gauge/sparkline; right group: git · cwd · title, right-aligned), and the
 * mode/hint line last. The right side of the footer shows the latest
 * transient notification (errors in red, warnings in amber — CC style).
 */
export declare function StatusLine({ channel, selectionActive, helpOpen, unreadFailures, }: {
    channel: Channel;
    selectionActive?: boolean;
    helpOpen?: boolean;
    /**
     * Count of failures the user has not looked at yet.
     *
     * Deliberately NOT a permanent readout. A chip that is always present and
     * always says the same thing is invisible within a day, and a live step
     * counter is both unactionable and a source of constant repaints. This badge
     * appears only when the session has something wrong that has not been seen,
     * and disappears once the trajectory has been opened — the appearance is
     * itself the message. Discovery of the key lives in the startup tip line;
     * the moment-of-failure prompt lives in a transient notification.
     */
    unreadFailures?: number;
}): React.JSX.Element;
//# sourceMappingURL=StatusLine.d.ts.map