import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import chalk from 'chalk';
import { Box, Text, useTheme } from '../../ui.js';
import { getTheme } from '../../theme.js';
import { alert, alive, mix } from '../../trajectory/motion.js';
import { parseRGB } from '../Spinner/spinnerUtils.js';
import { dominantChannel } from '../../dsh-adapter/trajectory/index.js';
/**
 * The wake — the whole session drawn as one row of glyphs.
 *
 * A session is a shape before it is a list: dense here, idle there, one red
 * mark where it broke. Three lanes of coloured blocks (the form the official
 * web overview uses, where vertical space is free) collapse badly into a
 * terminal, so they are composed instead into a single band whose **height**
 * carries activity and whose **colour** carries what kind of activity it was.
 * Errors and retries surface as marks above the line rather than as a fourth
 * lane, because a failure is an event on the session, not a channel of it.
 *
 * Every animated cell here changes colour only — never a glyph count, never a
 * row count (see `trajectory/motion.ts`).
 */
/** Eight block heights; index 0 is "some activity", not "none". */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
/** A column with no rows at all. */
const IDLE = '·';
/** Marks above the band. */
const MARK_ERROR = '▼';
const MARK_RETRY = '▿';
/** The live edge. */
const RUNNING = '▶';
/** Lane colour per channel, resolved from the active theme. */
function channelColor(channel, theme) {
    switch (channel) {
        case 'input': return theme.professionalBlue;
        case 'tool': return theme.chromeYellow;
        case 'model': return theme.autoAccept;
        default: return theme.subtle;
    }
}
export function WaveBand({ band, width, cursorColumn, viewportStart, viewportEnd, matches, tick, alertTick, }) {
    const [themeName] = useTheme();
    const theme = getTheme(themeName);
    if (band.buckets.length === 0) {
        return (_jsxs(Box, { flexDirection: "column", flexShrink: 0, children: [_jsx(Text, { color: "subtle", children: IDLE.repeat(Math.max(0, width)) }), _jsx(Text, { color: "subtle", children: ' '.repeat(Math.max(0, width)) })] }));
    }
    // ── the band itself ──────────────────────────────────────────────────────
    // Normalize between the smallest non-empty column and the tallest, both in
    // log space: the smallest real activity is one block, the busiest is eight,
    // and four orders of magnitude in between stay distinguishable.
    const logFloor = Math.log1p(Math.max(0, band.floor));
    const logSpan = Math.max(1e-6, Math.log1p(Math.max(1, band.peak)) - logFloor);
    const alertPhase = alert(tick, alertTick);
    const breath = alive(tick);
    let wave = '';
    let marks = '';
    for (let column = 0; column < band.buckets.length; column++) {
        const bucket = band.buckets[column];
        const dimmed = matches !== undefined && !matches.has(column);
        const isCursor = column === cursorColumn;
        // Marks row: errors and retries ride above the wave.
        if (bucket.error || bucket.retry) {
            const glyph = bucket.error ? MARK_ERROR : MARK_RETRY;
            marks += chalk.hex(toHex(mix(theme.error, theme.warningShimmer, alertPhase)))(glyph);
        }
        else {
            marks += ' ';
        }
        if (bucket.weight <= 0) {
            wave += chalk.hex(toHex(theme.subtle))(IDLE);
            continue;
        }
        if (bucket.running) {
            wave += chalk.hex(toHex(mix(theme.success, theme.planMode, breath)))(RUNNING);
            continue;
        }
        // Log scale: a session mixing three-minute calls with millisecond ones
        // spans four orders of magnitude, and a linear map would render one spike
        // over a flat line. log1p keeps the small work legible while the expensive
        // stretches still top out.
        const level = Math.min(BLOCKS.length - 1, Math.max(0, Math.round(((Math.log1p(bucket.weight) - logFloor) / logSpan) * (BLOCKS.length - 1))));
        const base = channelColor(dominantChannel(bucket), theme);
        // A dimmed (non-matching) column keeps its glyph — only its colour drops,
        // so the band's silhouette never changes while a query is being typed.
        const colour = dimmed ? theme.subtle : isCursor ? mix(base, theme.permissionShimmer, 0.6) : base;
        wave += chalk.hex(toHex(colour))(BLOCKS[level]);
    }
    // ── ruler: turn ticks plus the viewport bracket ──────────────────────────
    const ruler = Array.from({ length: band.buckets.length }, () => ' ');
    for (const [turn, column] of band.turns) {
        if (column < ruler.length)
            ruler[column] = turn % 5 === 0 ? '┼' : '╵';
    }
    const from = Math.max(0, Math.min(band.buckets.length - 1, viewportStart));
    const to = Math.max(from, Math.min(band.buckets.length - 1, viewportEnd));
    let rulerText = '';
    for (let column = 0; column < ruler.length; column++) {
        const inViewport = column >= from && column <= to;
        const glyph = inViewport ? (column === from ? '╰' : column === to ? '╯' : '─') : ruler[column];
        rulerText += inViewport
            ? chalk.hex(toHex(theme.permission))(glyph)
            : chalk.hex(toHex(theme.subtle))(glyph);
    }
    return (_jsxs(Box, { flexDirection: "column", flexShrink: 0, children: [_jsx(Text, { children: marks }), _jsx(Text, { children: wave }), _jsx(Text, { children: rulerText })] }));
}
/**
 * Convert a theme colour to the `#rrggbb` form chalk needs.
 *
 * Theme values are `rgb(r,g,b)` strings; a custom theme may instead carry an
 * ANSI name, which cannot be blended — those fall back to a neutral grey
 * rather than crashing chalk's hex parser.
 */
function toHex(colour) {
    if (colour.startsWith('#'))
        return colour;
    const parsed = parseRGB(colour);
    if (parsed === null)
        return '#8D95A6';
    const hex = (value) => value.toString(16).padStart(2, '0');
    return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`;
}
/** Shared by the scene so every chalk colour goes through one conversion. */
export { toHex as waveHex };
