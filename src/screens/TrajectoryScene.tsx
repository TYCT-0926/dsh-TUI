import React from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { useAnimationFrame } from '../ink/hooks/use-animation-frame.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { WaveBand } from '../components/trajectory/WaveBand.js'
import { Ledger } from '../components/trajectory/Ledger.js'
import { Inspector } from '../components/trajectory/Inspector.js'
import { HotspotView, hotspotRows } from '../components/trajectory/HotspotView.js'
import { applyQuery, parseQuery } from '../trajectory/query.js'
import { MOTION_TICK_MS } from '../trajectory/motion.js'
import { formatDuration, formatTokens } from '../trajectory/format.js'
import { t } from '../i18n.js'
import {
  aggregate,
  columnOfIndex,
  extendTrajectory,
  inspectNode,
  projectWave,
  type TrajBuild,
} from '../dsh-adapter/trajectory/index.js'
import { HOTSPOT_SORTS, WAVE_PROJECTIONS } from '../dsh-adapter/trajectory/index.js'
import type { Channel } from '../dsh-adapter/channel.js'
import type { HotspotSort, WaveProjection } from '../dsh-adapter/types.js'

/**
 * The trajectory scene — the session's own screen.
 *
 * Rather than carving a panel out of the conversation, the trajectory takes
 * the whole terminal the way `less`, `fzf` and `lazygit` do, and gives it back
 * untouched on exit. That is not only a layout choice: the alternate screen
 * has no scrollback, so none of the frame churn this view generates can reach
 * the transcript — the inline shrink-frame path that once deposited UI copies
 * into scrollback (issues #38/#39/#19/#10) is structurally out of reach here.
 *
 * Four regions, top to bottom: the header, the wake (whole session as one
 * band), the ledger, and the inspector. Every region except the ledger has a
 * fixed height, so moving the cursor never resizes the frame.
 */

/** Inspector height in the default (unexpanded) layout. */
const INSPECTOR_ROWS = 6
/** Rows reserved for header, wake and hints — everything but the ledger. */
const CHROME_ROWS = 2 + 3 + 1

export type TrajectoryView = 'timeline' | 'hotspot'

export function TrajectoryScene({
  channel,
  onClose,
}: {
  channel: Channel
  /** Leave the scene and return to the conversation. */
  onClose: () => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [ref, time] = useAnimationFrame(MOTION_TICK_MS)
  const tick = Math.floor(time / MOTION_TICK_MS)

  const [view, setView] = React.useState<TrajectoryView>('timeline')
  const [cursor, setCursor] = React.useState(0)
  const [hotCursor, setHotCursor] = React.useState(0)
  const [queryOpen, setQueryOpen] = React.useState(false)
  const [queryText, setQueryText] = React.useState('')
  const [projection, setProjection] = React.useState<WaveProjection>('sequence')
  const [sort, setSort] = React.useState<HotspotSort>('duration')
  const [expanded, setExpanded] = React.useState(false)
  const [inspectScroll, setInspectScroll] = React.useState(0)
  /** Ticks at which one-shot motion verbs were triggered. */
  const [switchTick, setSwitchTick] = React.useState(0)
  const [alertTick, setAlertTick] = React.useState(0)
  const [arrivalTick, setArrivalTick] = React.useState(0)
  const [arrivalFrom, setArrivalFrom] = React.useState(Number.MAX_SAFE_INTEGER)
  /** Cursor pinned to the tail until the user scrolls away from it. */
  const [follow, setFollow] = React.useState(true)

  // ── projection ───────────────────────────────────────────────────────────
  const buildRef = React.useRef<TrajBuild | null>(null)
  buildRef.current = extendTrajectory(buildRef.current, channel.traceEvents())
  const build = buildRef.current
  const nodes = build.nodes

  const query = React.useMemo(() => parseQuery(queryText), [queryText])
  const { rows: filtered, indexes } = React.useMemo(
    () => applyQuery(nodes, query),
    // `nodes` is mutated in place by the incremental fold, so its length is
    // the honest dependency — the array identity never changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [nodes, nodes.length, query],
  )

  const agg = React.useMemo(
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    () => aggregate(build, sort),
    [build, nodes.length, sort],
  )

  // ── arrival + alert detection ────────────────────────────────────────────
  const seenRef = React.useRef(0)
  const errorsRef = React.useRef(0)
  React.useEffect(() => {
    if (nodes.length > seenRef.current) {
      setArrivalFrom(seenRef.current)
      setArrivalTick(tick)
      seenRef.current = nodes.length
      if (follow) setCursor(Math.max(0, filtered.length - 1))
    }
    if (agg.totals.errors > errorsRef.current) {
      errorsRef.current = agg.totals.errors
      setAlertTick(tick)
    }
  }, [nodes.length, agg.totals.errors, tick, follow, filtered.length])

  // ── geometry ─────────────────────────────────────────────────────────────
  const inspectorRows = expanded ? Math.max(4, rows - CHROME_ROWS - 3) : INSPECTOR_ROWS
  const ledgerRows = Math.max(1, rows - CHROME_ROWS - inspectorRows - 1)
  const bandWidth = Math.max(1, columns - 2)

  const clampedCursor = filtered.length === 0 ? 0 : Math.min(cursor, filtered.length - 1)
  const windowStart = Math.max(
    0,
    Math.min(clampedCursor - Math.floor(ledgerRows / 2), filtered.length - ledgerRows),
  )

  const band = React.useMemo(
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    () => projectWave(nodes, bandWidth, projection),
    [nodes, nodes.length, bandWidth, projection],
  )
  const matchColumns = React.useMemo(() => {
    if (query.empty) return undefined
    const set = new Set<number>()
    for (const index of indexes) set.add(columnOfIndex(band, index))
    return set
  }, [band, indexes, query.empty])

  const focused = filtered[clampedCursor]
  const detail = React.useMemo(
    () => (focused === undefined ? undefined : inspectNode(focused, channel.traceEvents())),
    [focused, channel],
  )

  // ── navigation helpers ───────────────────────────────────────────────────
  const move = React.useCallback(
    (delta: number) => {
      setExpanded(false)
      setInspectScroll(0)
      setCursor(previous => {
        const next = Math.max(0, Math.min(filtered.length - 1, previous + delta))
        setFollow(next >= filtered.length - 1)
        return next
      })
    },
    [filtered.length],
  )

  const seek = React.useCallback(
    (predicate: (index: number) => boolean, forward: boolean) => {
      const from = clampedCursor
      const limit = filtered.length
      for (let step = 1; step <= limit; step++) {
        const index = forward ? from + step : from - step
        if (index < 0 || index >= limit) continue
        if (predicate(index)) {
          setExpanded(false)
          setInspectScroll(0)
          setCursor(index)
          setFollow(index >= limit - 1)
          return
        }
      }
    },
    [clampedCursor, filtered.length],
  )

  const isFailure = React.useCallback(
    (index: number): boolean => {
      const node = filtered[index]
      return (
        node !== undefined &&
        (node.status === 'error' || node.kind === 'retry' || (node.burst?.members.some(m => m.status === 'error') ?? false))
      )
    },
    [filtered],
  )

  const switchView = React.useCallback(
    (next: TrajectoryView) => {
      setView(next)
      setSwitchTick(tick)
      setExpanded(false)
      setInspectScroll(0)
    },
    [tick],
  )

  // ── keys ─────────────────────────────────────────────────────────────────
  useInput((input, key) => {
    // The query line owns the keyboard while open, so a `q` typed into a
    // search does not close the scene.
    if (queryOpen) {
      if (key.escape) {
        setQueryOpen(false)
        setQueryText('')
        return
      }
      if (key.return) {
        setQueryOpen(false)
        return
      }
      if (key.backspace || key.delete) {
        setQueryText(previous => previous.slice(0, -1))
        setCursor(0)
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setQueryText(previous => previous + input)
        setCursor(0)
      }
      return
    }

    if (key.escape || input === 'q') {
      if (expanded) {
        setExpanded(false)
        setInspectScroll(0)
        return
      }
      if (!query.empty) {
        setQueryText('')
        return
      }
      onClose()
      return
    }

    if (key.leftArrow) return switchView('timeline')
    if (key.rightArrow) return switchView('hotspot')
    if (input === 'h') return switchView(view === 'hotspot' ? 'timeline' : 'hotspot')
    if (input === '/') {
      setQueryOpen(true)
      return
    }

    if (view === 'hotspot') {
      const total = hotspotRows(agg).length
      if (key.upArrow) return setHotCursor(previous => Math.max(0, previous - 1))
      if (key.downArrow) return setHotCursor(previous => Math.min(total - 1, previous + 1))
      if (input === 't') {
        setSort(previous => HOTSPOT_SORTS[(HOTSPOT_SORTS.indexOf(previous) + 1) % HOTSPOT_SORTS.length]!)
        setSwitchTick(tick)
        return
      }
      if (key.return) {
        // Jump back to the timeline, positioned on the group's first member.
        const row = hotspotRows(agg)[hotCursor]
        switchView('timeline')
        if (row !== undefined) {
          const target = indexes.indexOf(row.firstIndex)
          setCursor(target >= 0 ? target : 0)
          setFollow(false)
        }
        return
      }
      return
    }

    if (key.upArrow) return move(-1)
    if (key.downArrow) return move(1)
    if (key.pageUp) return move(-ledgerRows)
    if (key.pageDown) return move(ledgerRows)
    if (input === 'g') {
      setCursor(0)
      setFollow(false)
      return
    }
    if (input === 'G') {
      setCursor(Math.max(0, filtered.length - 1))
      setFollow(true)
      return
    }
    if (input === '[') return seek(isFailure, false)
    if (input === ']') return seek(isFailure, true)
    if (input === '{') return seek(index => filtered[index]?.kind === 'turn', false)
    if (input === '}') return seek(index => filtered[index]?.kind === 'turn', true)
    if (input === 'm') {
      setProjection(previous => WAVE_PROJECTIONS[(WAVE_PROJECTIONS.indexOf(previous) + 1) % WAVE_PROJECTIONS.length]!)
      setSwitchTick(tick)
      return
    }
    if (key.return) {
      setExpanded(previous => !previous)
      setInspectScroll(0)
      return
    }
    if (expanded && (input === 'j' || input === 'k')) {
      setInspectScroll(previous => Math.max(0, previous + (input === 'j' ? inspectorRows - 2 : -(inspectorRows - 2))))
    }
  })

  // ── header ───────────────────────────────────────────────────────────────
  const { totals } = agg
  // Every fixed region declares `flexShrink={0}`. Without it, a viewport one
  // row short of the laid-out content makes yoga collapse the FIRST flexible
  // child to zero height — the header silently vanished instead of the ledger
  // giving up a row.
  const header = (
    <Box flexDirection="row" width="100%" gap={2} flexShrink={0}>
      <Box flexShrink={0}>
        <Text color="claude" bold>
          ✦ {t('traj-title')}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate" color="subtle">
          {channel.sessionTitle ?? channel.cwd}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color="subtle">
          {t('traj-totals', { turns: totals.turns, steps: totals.rows })}
          {totals.errors > 0 ? <Text color="error">{` · ${t('traj-errors', { n: totals.errors })}`}</Text> : ''}
          {totals.retries > 0 ? <Text color="warning">{` · ${t('traj-retries', { n: totals.retries })}`}</Text> : ''}
          {` · ${formatDuration(totals.spanMs)}`}
        </Text>
      </Box>
    </Box>
  )

  const tabs = (
    <Box flexDirection="row" width="100%" gap={2} flexShrink={0}>
      <Box flexShrink={0} flexDirection="row" gap={2}>
        <Text color={view === 'timeline' ? 'permission' : 'subtle'} bold={view === 'timeline'}>
          {view === 'timeline' ? '●' : '○'} {t('traj-tab-timeline')}
        </Text>
        <Text color={view === 'hotspot' ? 'permission' : 'subtle'} bold={view === 'hotspot'}>
          {view === 'hotspot' ? '●' : '○'} {t('traj-tab-hotspot')}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        {queryOpen || !query.empty ? (
          <Text wrap="truncate">
            <Text color="permission">/ </Text>
            <Text color="suggestion">{queryText}</Text>
            {queryOpen ? <Text color="subtle">▌</Text> : ''}
            <Text color="subtle">
              {`  ${t('traj-matches', { n: filtered.length, total: nodes.length })}`}
            </Text>
          </Text>
        ) : (
          <Text> </Text>
        )}
      </Box>
      <Box flexShrink={0}>
        <Text color="subtle">
          {view === 'hotspot' ? t(`traj-sort-${sort}`) : t(`traj-proj-${projection}`)}
        </Text>
      </Box>
    </Box>
  )

  const hints =
    view === 'hotspot'
      ? t('traj-hint-hotspot')
      : queryOpen
        ? t('traj-hint-query')
        : expanded
          ? t('traj-hint-expanded')
          : t('traj-hint-timeline')

  return (
    // `flexGrow`, not an explicit `height={rows}`: in inline mode the scene is
    // nested inside `<AlternateScreen>`, whose own Box is already pinned to the
    // terminal height. Restating that height here made the two claims add up to
    // one row more than the viewport, which scrolled the header off the top.
    <Box ref={ref} flexDirection="column" width="100%" paddingX={1}>
      {header}
      {tabs}
      <WaveBand
        band={band}
        width={bandWidth}
        cursorColumn={columnOfIndex(band, indexes[clampedCursor] ?? 0)}
        viewportStart={columnOfIndex(band, indexes[windowStart] ?? 0)}
        viewportEnd={columnOfIndex(band, indexes[Math.min(filtered.length - 1, windowStart + ledgerRows - 1)] ?? 0)}
        matches={matchColumns}
        tick={tick}
        alertTick={alertTick}
      />
      {view === 'timeline' ? (
        <>
          <Ledger
            rows={filtered}
            offsets={indexes}
            start={windowStart}
            height={ledgerRows}
            cursor={clampedCursor}
            width={columns - 2}
            tick={tick}
            arrivalTick={arrivalTick}
            arrivalFrom={arrivalFrom}
          />
          {/* `Divider` defaults to the FULL terminal width; inside this
              padded scene that overflows by two cells and wraps onto a
              second row, which pushed the header off the top of the
              viewport. Size it to the scene's own content width. */}
          <Divider color="permission" width={bandWidth} />
          <Inspector
            node={focused}
            detail={detail}
            height={inspectorRows}
            width={columns - 2}
            expanded={expanded}
            scroll={inspectScroll}
          />
        </>
      ) : (
        <HotspotView
          agg={agg}
          sort={sort}
          width={columns - 2}
          height={ledgerRows + inspectorRows + 1}
          cursor={hotCursor}
          tick={tick}
          switchTick={switchTick}
        />
      )}
      <Box width="100%" flexShrink={0}>
        <Text dimColor italic wrap="truncate">
          <HintLine text={hints} />
          {totals.tokens.input > 0 ? (
            <Text color="subtle">{`   ${formatTokens(totals.tokens.input)}→${formatTokens(totals.tokens.output)}`}</Text>
          ) : (
            ''
          )}
        </Text>
      </Box>
    </Box>
  )
}
