import React from 'react'
import { Box, Text } from '../../ui.js'
import { previewText } from '../../dsh-adapter/trajectory/index.js'
import {
  formatDuration,
  heatColor,
  KIND_BADGE,
  KIND_BADGE_BG,
  KIND_FG,
  KIND_GLYPH,
  ledgerLayout,
} from '../../trajectory/format.js'
import { arrive, mix } from '../../trajectory/motion.js'
import { getTheme } from '../../theme.js'
import { useTheme } from '../../ui.js'
import type { TrajNode } from '../../dsh-adapter/types.js'

/**
 * The ledger — one line per event, columns aligned across every row.
 *
 * Two decisions carry most of the readability:
 *
 * **Flat rows, spined turns.** Indenting by turn would break the column
 * alignment that makes forty rows scannable at a glance, so rows stay flush
 * and a two-cell spine on the left (`╭ │ ╰`, the git-graph idiom) carries the
 * grouping instead. The spine is itself information: it turns red for a turn
 * that failed and breathes green for the turn still running.
 *
 * **Call and result on one line.** `name {args} → result` — the same shape the
 * official web ledger uses, and the reason a screenful answers "what did it
 * do and what came back" without a single expansion.
 *
 * Rows are windowed by the caller; this component paints only what it is
 * given, and calls {@link previewText} exactly once per visible cell.
 */

/** Spine glyphs by position within a turn. */
const SPINE = { open: '╭', mid: '│', close: '╰', none: ' ' } as const

/** Which spine glyph a row gets, given its neighbours' turns. */
function spineGlyph(rows: readonly TrajNode[], index: number): string {
  const node = rows[index]!
  if (node.kind === 'turn') return SPINE.open
  const next = rows[index + 1]
  if (next === undefined || next.turn !== node.turn || next.kind === 'turn') return SPINE.close
  return SPINE.mid
}

export function Ledger({
  rows,
  offsets,
  start,
  height,
  cursor,
  width,
  tick,
  arrivalTick,
  arrivalFrom,
}: {
  /** The (possibly filtered) ledger. */
  rows: readonly TrajNode[]
  /** Original ledger index of each row, for the `#N` column. */
  offsets: readonly number[]
  /** Index of the first visible row. */
  start: number
  /** Visible row count. */
  height: number
  /** Focused row index into `rows`. */
  cursor: number
  /** Terminal width in cells. */
  width: number
  tick: number
  /** Tick at which the most recent rows arrived. */
  arrivalTick: number
  /** Rows at or after this index are the ones that just arrived. */
  arrivalFrom: number
}): React.ReactNode {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const layout = ledgerLayout(width)
  const visible = rows.slice(start, start + height)
  const arriving = arrive(tick, arrivalTick)

  // The ledger is the scene's only elastic region: the chrome above and the
  // inspector below have fixed heights, so `flexGrow` here absorbs whatever
  // the viewport actually offers. That is deliberately more robust than
  // matching the terminal height by arithmetic — a one-row disagreement with
  // the host (an alt-screen wrapper that also claims the full height, say)
  // clips one ledger row instead of scrolling the header off the top.
  if (visible.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        <Text color="subtle">—</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      {visible.map((node, offset) => {
        const index = start + offset
        const focused = index === cursor
        const failed = node.status === 'error' || (node.burst?.members.some(m => m.status === 'error') ?? false)
        const running = node.status === 'running'
        const isNew = index >= arrivalFrom && arriving > 0

        // Spine colour is the turn's health, not the row's.
        const spineColor = failed ? 'error' : running ? 'success' : node.seed === true ? 'subtle' : 'inactive'

        const badgeBg = KIND_BADGE_BG[node.kind]
        const badge = layout.badge === 4 ? KIND_BADGE[node.kind] : KIND_GLYPH[node.kind]

        // Label + detail share one budget so a long tool name never pushes
        // the duration column off the row.
        const label = node.burst !== undefined ? `${node.label} ×${node.burst.members.length}` : node.label
        const detailBudget = Math.max(0, layout.detail - label.length - 1)
        const detail = node.detail === undefined ? '' : previewText(node.detail, detailBudget)
        const outcome =
          layout.outcome && node.outcome !== undefined && node.outcome !== ''
            ? previewText(node.outcome, Math.max(8, Math.floor(layout.detail * 0.35)))
            : ''

        const duration =
          node.burst !== undefined
            ? node.burst.members.reduce((sum, m) => sum + (m.durationMs ?? 0), 0)
            : node.durationMs

        return (
          <Box key={`${node.seq}:${node.kind}`} flexDirection="row" width="100%" gap={1}>
            <Box flexShrink={0}>
              <Text color={spineColor}>
                {focused ? '▸' : ' '}
                {spineGlyph(rows, index)}
              </Text>
            </Box>
            {layout.index && (
              <Box flexShrink={0} width={5}>
                <Text color="subtle">{`#${offsets[index] ?? index}`}</Text>
              </Box>
            )}
            <Box flexShrink={0}>
              <Text
                color={isNew ? mix(theme[KIND_FG[node.kind]] as string, theme.text, arriving) : KIND_FG[node.kind]}
                backgroundColor={badgeBg}
                bold
              >
                {badge}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate" color={focused ? 'suggestion' : node.seed === true ? 'subtle' : undefined}>
                {label}
                {detail === '' ? '' : ' '}
                <Text color={focused ? 'suggestion' : 'inactive'}>{detail}</Text>
                {outcome === '' ? '' : <Text color="subtle">{`  → ${outcome}`}</Text>}
              </Text>
            </Box>
            <Box flexShrink={0} justifyContent="flex-end" width={7}>
              <Text color={running ? 'success' : heatColor(duration)}>
                {running ? '…' : duration === undefined ? '' : formatDuration(duration)}
              </Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
