/**
 * Wave band projection — the whole session compressed onto one row of glyphs.
 *
 * The band answers, without reading a single word: how long was this session,
 * where was it dense, where did it idle, where did it fail, and where am I
 * looking right now. It is the trajectory's coarse navigation axis — a few
 * keypresses cross a session that would take dozens of scrolls in the ledger.
 *
 * ## Three projections, one shape
 *
 * `sequence` gives every row equal width — best for scanning *what* happened.
 * `time` maps real wall-clock, so a five-minute tool call is visibly five
 * minutes and idle gaps are visibly idle. `compressed` keeps wall-clock
 * proportions but caps each inter-row gap, which is what you want on a session
 * that sat idle overnight between two bursts of work.
 *
 * ## Purity and cost
 *
 * {@link projectWave} is pure and O(nodes + columns). It is recomputed only
 * when the node count, the column count, or the projection changes — the
 * caller memoizes on exactly those three, which is why no cache lives here.
 */
/**
 * Longest inter-row gap the `compressed` projection preserves. Beyond this a
 * gap contributes a fixed width, so an overnight pause reads as "a pause"
 * instead of flattening the entire session into one column.
 */
const GAP_CAP_MS = 2_000;
/** Which band channel a row contributes its weight to. */
export function channelOf(kind) {
    switch (kind) {
        case 'user':
        case 'context':
        case 'todo':
            return 'input';
        case 'tool':
        case 'subtool':
        case 'approval':
        case 'compaction':
            return 'tool';
        default:
            // turn / step / assistant / thinking / retry / system
            return 'model';
    }
}
/**
 * Weight one row contributes to its column.
 *
 * Structural rows (turn/step) are deliberately light: they mark boundaries
 * rather than work, and counting them equally would make a session of many
 * short turns look busier than one doing heavy tool work.
 */
function weightOf(node) {
    if (node.kind === 'turn' || node.kind === 'step')
        return 0.25;
    if (node.burst !== undefined)
        return Math.min(4, node.burst.members.length);
    return 1;
}
/** Positions of each row along the projection's horizontal domain, in [0, 1]. */
function positions(nodes, projection) {
    const count = nodes.length;
    if (count === 0)
        return [];
    if (count === 1)
        return [0];
    /** Equal spacing — the fallback whenever a time domain would divide by zero. */
    const even = () => Array.from({ length: count }, (_, index) => index / (count - 1));
    if (projection === 'sequence')
        return even();
    if (projection === 'time') {
        const first = nodes[0].time;
        const span = nodes[count - 1].time - first;
        // A zero span (every row inside the same millisecond) has no meaningful
        // time axis; fall back to equal spacing rather than dividing by zero.
        if (span <= 0)
            return even();
        return Array.from({ length: count }, (_, index) => (nodes[index].time - first) / span);
    }
    // compressed: accumulate inter-row gaps, each capped.
    let accumulated = 0;
    const cumulative = Array.from({ length: count }, (_, index) => {
        if (index > 0) {
            const gap = nodes[index].time - nodes[index - 1].time;
            accumulated += Math.min(Math.max(0, gap), GAP_CAP_MS);
        }
        return accumulated;
    });
    if (accumulated <= 0)
        return even();
    return cumulative.map(value => value / accumulated);
}
/**
 * Project the ledger onto a fixed number of columns.
 *
 * @param nodes - The folded ledger, in log order.
 * @param columns - Column count; normally the band's rendered width.
 * @param projection - Horizontal domain (see the module comment).
 * @returns The band, with `peak` for glyph scaling and turn markers for the
 *   ruler row. An empty ledger yields zero buckets and `peak` 0.
 */
export function projectWave(nodes, columns, projection = 'sequence') {
    const width = Math.max(0, Math.floor(columns));
    if (width === 0 || nodes.length === 0)
        return { buckets: [], peak: 0, turns: [] };
    const buckets = Array.from({ length: width }, () => ({
        weight: 0,
        channels: { input: 0, model: 0, tool: 0 },
        error: false,
        retry: false,
        running: false,
        firstIndex: -1,
    }));
    const pos = positions(nodes, projection);
    const turns = [];
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        // `pos` is in [0, 1]; the final row must land inside the last column.
        const column = Math.min(width - 1, Math.floor(pos[index] * width));
        const slot = buckets[column];
        const weight = weightOf(node);
        slot.weight += weight;
        slot.channels[channelOf(node.kind)] += weight;
        if (slot.firstIndex === -1)
            slot.firstIndex = index;
        if (node.status === 'error' || (node.burst?.members.some(m => m.status === 'error') ?? false)) {
            slot.error = true;
        }
        if (node.kind === 'retry')
            slot.retry = true;
        if (node.status === 'running')
            slot.running = true;
        if (node.kind === 'turn')
            turns.push([node.turn, column]);
    }
    // Empty columns inherit the previous column's seek target, so clicking or
    // scanning across an idle stretch lands on the row that started it rather
    // than on nothing.
    let carry = 0;
    for (const slot of buckets) {
        if (slot.firstIndex === -1)
            slot.firstIndex = carry;
        else
            carry = slot.firstIndex;
    }
    let peak = 0;
    for (const slot of buckets)
        if (slot.weight > peak)
            peak = slot.weight;
    return { buckets, peak, turns };
}
/** The dominant channel of a column, or `undefined` for an empty column. */
export function dominantChannel(bucket) {
    const { input, model, tool } = bucket.channels;
    if (input === 0 && model === 0 && tool === 0)
        return undefined;
    if (tool >= model && tool >= input)
        return 'tool';
    if (model >= input)
        return 'model';
    return 'input';
}
/**
 * Map a ledger index back to its column — the inverse used to draw the
 * viewport bracket under the band.
 *
 * @returns Column index, clamped into range; 0 for an empty band.
 */
export function columnOfIndex(band, ledgerIndex) {
    if (band.buckets.length === 0)
        return 0;
    // Buckets are monotonic in `firstIndex` after the carry pass, so a linear
    // scan from the right finds the owning column in one pass without needing a
    // parallel index array.
    for (let column = band.buckets.length - 1; column >= 0; column--) {
        if (band.buckets[column].firstIndex <= ledgerIndex)
            return column;
    }
    return 0;
}
