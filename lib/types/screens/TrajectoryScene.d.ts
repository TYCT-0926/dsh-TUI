import React from 'react';
import type { Channel } from '../dsh-adapter/channel.js';
export type TrajectoryView = 'timeline' | 'hotspot';
export declare function TrajectoryScene({ channel, onClose, }: {
    channel: Channel;
    /** Leave the scene and return to the conversation. */
    onClose: () => void;
}): React.ReactNode;
//# sourceMappingURL=TrajectoryScene.d.ts.map