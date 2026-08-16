/**
 * Session browser formatting.
 *
 * Presentation only, and deliberately outside the adapter: these are choices
 * about a terminal's width and a reader's eye, not about what a session log
 * means.
 *
 * @module @deepseek-harness-tui/dsh-tui/sessions/format
 */
import { t } from '../i18n.js';
import { stringWidth } from '../ink/stringWidth.js';
/**
 * Truncate to a terminal DISPLAY width, CJK-aware (a wide character costs two
 * columns).
 *
 * Used wherever the cut has to be exact: Ink's own `wrap="truncate"` appends
 * its ellipsis as soon as content is as wide as its box rather than wider,
 * which silently eats the last character of a row laid out at its natural
 * width — and a row that then reflows pushes every row below it down.
 *
 * @param text - Plain text, no ANSI.
 * @param maxWidth - Column budget, ellipsis included.
 * @returns `text` when it fits, otherwise a cut ending in `…`.
 */
export function truncateWidth(text, maxWidth) {
    if (maxWidth <= 0)
        return '';
    if (stringWidth(text) <= maxWidth)
        return text;
    let width = 0;
    let out = '';
    for (const char of text) {
        const charWidth = stringWidth(char);
        if (width + charWidth > maxWidth - 1)
            break;
        width += charWidth;
        out += char;
    }
    return `${out}…`;
}
/**
 * Elapsed time as a person would say it: `just now`, `9 hours ago`, and an
 * absolute date once "ago" stops being useful.
 *
 * The cut to an absolute date is at a week rather than a month because that is
 * roughly where a relative offset stops locating anything — "23 days ago" is a
 * number to be decoded, `Mar 3` is a memory.
 *
 * @param at - Epoch ms of the moment being described.
 * @param now - Epoch ms of the present, injectable so the formatter is a pure
 *   function and its regression does not depend on a clock.
 */
export function formatWhen(at, now) {
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 45)
        return t('session-when-now');
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return t('session-when-minutes', { n: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24)
        return t('session-when-hours', { n: hours });
    const days = Math.round(hours / 24);
    if (days <= 7)
        return t('session-when-days', { n: days });
    const date = new Date(at);
    return t('session-when-date', {
        month: String(date.getMonth() + 1),
        day: String(date.getDate()),
    });
}
/**
 * Byte size at the precision the number is worth: `812 B`, `142.9 KB`,
 * `4.2 MB`. One decimal from kilobytes up, because the digit distinguishes a
 * short exchange from a long one and a second would not.
 */
export function formatBytes(bytes) {
    if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0)
        return undefined;
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * Marker for a row's kind, or undefined for an ordinary conversation.
 *
 * Only the exceptional kinds are marked. A badge on every row would cost a
 * column of width and teach nothing — what a reader needs to see at a glance
 * is which rows are *not* the thing they came for.
 */
export function kindMark(kind) {
    if (kind.kind === 'subagent')
        return { glyph: '⑂', color: 'autoAccept' };
    if (kind.kind === 'fork')
        return { glyph: '⑃', color: 'planMode' };
    return undefined;
}
/**
 * Wrap to a display width, CJK-aware.
 *
 * Greedy, breaking on a space when one is available in the line just filled
 * and mid-character when it is not — which is the correct behaviour for CJK,
 * where there are no spaces to break on and a word-only wrapper would emit one
 * enormous unbreakable line. Newlines in the input are honoured.
 *
 * @param text - Plain text, no ANSI.
 * @param width - Column budget per line.
 * @returns The wrapped lines, never empty for non-empty input.
 */
export function wrapWidth(text, width) {
    if (width <= 0)
        return [];
    const lines = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        let used = 0;
        for (const char of paragraph) {
            const charWidth = stringWidth(char);
            if (used + charWidth > width) {
                // Prefer a word boundary, but only when it does not throw away most
                // of the line — a single long token must still make progress.
                const breakAt = line.lastIndexOf(' ');
                if (breakAt > width / 2) {
                    lines.push(line.slice(0, breakAt));
                    line = line.slice(breakAt + 1);
                    used = stringWidth(line);
                }
                else {
                    lines.push(line);
                    line = '';
                    used = 0;
                }
            }
            line += char;
            used += charWidth;
        }
        lines.push(line);
    }
    return lines;
}
/** Human name of a session kind, for the preview pane's header. */
export function kindLabel(kind) {
    if (kind.kind === 'subagent')
        return t('session-kind-subagent');
    if (kind.kind === 'fork')
        return t('session-kind-fork');
    return t('session-kind-root');
}
/**
 * Colour for a title, by how much is actually known about it.
 *
 * A title the user chose is stated plainly; one a model generated reads the
 * same, because it is a real title; a first-prompt excerpt is dimmer, because
 * it is the session speaking rather than a name; a directory basename is
 * dimmest of all, because it says only "nothing here was readable".
 */
export function titleColor(source, focused) {
    if (focused)
        return 'suggestion';
    if (source === 'fallback')
        return 'subtle';
    if (source === 'prompt')
        return 'inactive';
    return 'text';
}
/**
 * Project label for a group header: the working directory, with `$HOME`
 * collapsed to `~` so the eye lands on the part that differs.
 */
export function formatProject(cwd, home) {
    if (cwd.length === 0)
        return t('session-project-unknown');
    const normalized = cwd.replace(/\\/g, '/');
    const base = home.replace(/\\/g, '/').replace(/\/$/, '');
    if (base.length > 0 && (normalized === base || normalized.startsWith(`${base}/`))) {
        return `~${normalized.slice(base.length)}`;
    }
    return normalized;
}
