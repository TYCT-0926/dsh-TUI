import React from 'react'
import { Box, Text, useTheme } from '../../ui.js'
import { getTheme } from '../../theme.js'
import { formatDuration, formatTokens } from '../../trajectory/format.js'
import { mix, reproject } from '../../trajectory/motion.js'
import { t } from '../../i18n.js'
import type { HotspotRow, HotspotSort, TrajAggregate } from '../../dsh-adapter/types.js'

/**
 * The hotspot view — the session ranked by cost instead of ordered by time.
 *
 * Chronology is the wrong order for "where did my half hour go": the answer is
 * a ranking, and a ranking is what this shows — cost per tool, per model phase
 * (decode vs. waiting for the first token vs. retry backoff), per turn.
 *
 * The reveal is a staggered brightening rather than a growing bar. A bar that
 * grew would change its glyph count every frame, which is a layout change, and
 * layout changes are the one thing the motion rules forbid. Sweeping colour
 * across already-final bars reads the same and costs style bytes.
 */

/** Bar cell; a half block gives one extra step of resolution for free. */
const FULL = '█'
const HALF = '▌'

function bar(value: number, max: number, width: number): string {
  if (max <= 0 || width <= 0) return ''
  const exact = (value / max) * width
  const full = Math.floor(exact)
  return FULL.repeat(Math.min(width, full)) + (exact - full >= 0.5 && full < width ? HALF : '')
}

/** One ranked section. */
function Section({
  title,
  rows,
  sort,
  barWidth,
  labelWidth,
  colorKey,
  cursor,
  offset,
  tick,
  switchTick,
}: {
  title: string
  rows: readonly HotspotRow[]
  sort: HotspotSort
  barWidth: number
  labelWidth: number
  colorKey: 'chromeYellow' | 'autoAccept' | 'professionalBlue'
  /** Global row cursor across all sections, or -1 when not in this section. */
  cursor: number
  /** Index of this section's first row in the flattened row list. */
  offset: number
  tick: number
  switchTick: number
}): React.ReactNode {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  if (rows.length === 0) return null
  const max = Math.max(...rows.map(row => (sort === 'count' ? row.count : sort === 'tokens' ? row.tokens : row.totalMs)), 1)

  return (
    <Box flexDirection="column">
      <Text color="subtle">{title}</Text>
      {rows.map((row, index) => {
        const value = sort === 'count' ? row.count : sort === 'tokens' ? row.tokens : row.totalMs
        // Stagger the settle by row so the section reads top-down on switch.
        const dim = reproject(tick - index, switchTick)
        const base = row.error === true ? theme.error : theme[colorKey]
        const focused = cursor === offset + index
        return (
          <Box key={row.label} flexDirection="row" gap={1} width="100%">
            <Box flexShrink={0} width={2}>
              <Text color="suggestion">{focused ? '▸' : ' '}</Text>
            </Box>
            <Box flexShrink={0} width={labelWidth}>
              <Text wrap="truncate" color={focused ? 'suggestion' : row.error === true ? 'error' : undefined}>
                {row.label}
              </Text>
            </Box>
            <Box flexShrink={0} width={barWidth}>
              <Text color={mix(base as string, theme.background as string, dim)}>{bar(value, max, barWidth)}</Text>
            </Box>
            <Box flexShrink={0} width={8} justifyContent="flex-end">
              <Text bold color={row.error === true ? 'error' : undefined}>
                {formatDuration(row.totalMs)}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color="subtle">
                {`${row.count}×`}
                {row.tokens > 0 ? ` · ${formatTokens(row.tokens)}` : ''}
                {row.count > 0 && row.totalMs > 0 ? ` · ⌀${formatDuration(row.totalMs / row.count)}` : ''}
              </Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

/** Flatten the three sections into the single list the cursor walks. */
export function hotspotRows(agg: TrajAggregate): HotspotRow[] {
  return [...agg.tools, ...agg.model, ...agg.turns]
}

export function HotspotView({
  agg,
  sort,
  width,
  height,
  cursor,
  tick,
  switchTick,
}: {
  agg: TrajAggregate
  sort: HotspotSort
  width: number
  height: number
  cursor: number
  tick: number
  switchTick: number
}): React.ReactNode {
  const labelWidth = Math.min(18, Math.max(10, Math.floor(width * 0.16)))
  const barWidth = Math.max(6, Math.min(34, width - labelWidth - 26))

  return (
    <Box flexDirection="column" height={height} flexShrink={0} gap={0}>
      <Section
        title={t('traj-hot-tools')}
        rows={agg.tools}
        sort={sort}
        barWidth={barWidth}
        labelWidth={labelWidth}
        colorKey="chromeYellow"
        cursor={cursor}
        offset={0}
        tick={tick}
        switchTick={switchTick}
      />
      <Section
        title={t('traj-hot-model')}
        rows={agg.model}
        sort={sort}
        barWidth={barWidth}
        labelWidth={labelWidth}
        colorKey="autoAccept"
        cursor={cursor}
        offset={agg.tools.length}
        tick={tick}
        switchTick={switchTick}
      />
      <Section
        title={t('traj-hot-turns')}
        rows={agg.turns}
        sort={sort}
        barWidth={barWidth}
        labelWidth={labelWidth}
        colorKey="professionalBlue"
        cursor={cursor}
        offset={agg.tools.length + agg.model.length}
        tick={tick}
        switchTick={switchTick}
      />
    </Box>
  )
}
