import React from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { SearchBox } from '../components/SearchBox.js'
import { SessionListRow } from '../components/sessions/SessionListRow.js'
import { SessionPreview } from '../components/sessions/SessionPreview.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { isMod, isPlainReturn, modLabel } from '../utils/modifiers.js'
import { formatProject, truncateWidth } from '../sessions/format.js'
import {
  anchorTop,
  buildView,
  DEFAULT_FILTERS,
  moveSelection,
  seekSelectable,
  sessionAt,
  windowEnd,
  type BrowserFilters,
} from '../sessions/view.js'
import { t } from '../i18n.js'
import type { Channel } from '../dsh-adapter/channel.js'
import type { PreviewEntry, SessionSummary } from '../dsh-adapter/sessions/index.js'

/** What the browser is doing with the focused row. */
type BrowserMode = 'list' | 'confirm-delete' | 'rename' | 'confirm-clean'

/** Chrome lines the layout always spends: header, three rules, hint row. */
const CHROME_LINES = 6
/** Terminal width below which the preview replaces the list instead of joining it. */
const SPLIT_MIN_COLUMNS = 100

/**
 * The session browser — `/resume` as a screen of its own.
 *
 * The old picker was a panel of eight titles and a timestamp, and the reason
 * it could not be more than that was never layout: the data behind it was five
 * fields wide. With every session now arriving classified, sized, dated and
 * attributed, the surface that shows them can do the job a person actually
 * came for — find one conversation among many.
 *
 * What that means concretely:
 *
 * - Search is always live. There is no mode to enter; typing filters, because
 *   the list is the search results.
 * - Delegated sub-agent runs are folded away by default and revealed under
 *   their parents on demand. They are not noise to be deleted — they are the
 *   model's own work, and it is worth being able to open one — but they are
 *   not what "resume a conversation" means, and there are five of them for
 *   every conversation.
 * - Sessions that hold no conversation are never listed, only counted, with
 *   one action to clear them.
 * - The preview shows the end of a session, so "is this the one I was in the
 *   middle of" is answerable without resuming it.
 *
 * Every one of those reads bounded data, so the screen behaves the same on a
 * fifty-session history as on a five-session one.
 */
export function SessionBrowser({
  channel,
  home,
  sameProject,
  onClose,
}: {
  channel: Channel
  /** Home directory, for collapsing project paths to `~`. */
  home: string
  /** Whether a stored cwd belongs to the same project as the live session. */
  sameProject: (a: string, b: string) => boolean
  onClose: () => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const isTerminalFocused = useTerminalFocus()

  const [sessions, setSessions] = React.useState<readonly SessionSummary[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const [filters, setFilters] = React.useState<BrowserFilters>(DEFAULT_FILTERS)
  // The cursor is a session ID, not a row index.
  //
  // Rows are reordered by almost everything the browser does: a rename touches
  // MRU and moves its row to the top, a filter rebuilds the list, a delete
  // removes one. An index survives none of those — it keeps pointing at a
  // POSITION, so the cursor silently lands on a different session and the next
  // Enter or ctrl+d acts on the wrong one. Tracking identity makes "the cursor
  // stays on the session you were looking at" true by construction instead of
  // something every mutation has to remember to restore.
  const [focusId, setFocusId] = React.useState<string | undefined>(undefined)
  // The window start is a scroll anchor, not state: it is derived from the
  // focus every render and only ever read back to keep a stationary cursor
  // from re-shuffling the screen. Holding it in state would mean setting
  // state during render to resolve a layout that render already knows.
  const topRef = React.useRef(0)
  const [mode, setMode] = React.useState<BrowserMode>('list')
  const [renameText, setRenameText] = React.useState('')
  const [previewOpen, setPreviewOpen] = React.useState(false)
  const [preview, setPreview] = React.useState<readonly PreviewEntry[]>([])
  const [previewLoading, setPreviewLoading] = React.useState(false)

  // One clock per render pass: every relative time on screen must agree, and
  // re-reading it per row would let two rows a millisecond apart round to
  // different minutes.
  const now = Date.now()

  const reload = React.useCallback(async () => {
    const listed = await channel.listSessions()
    setSessions(listed)
    setLoaded(true)
  }, [channel])

  React.useEffect(() => {
    void reload()
  }, [reload])

  const view = React.useMemo(
    () =>
      buildView(sessions, filters, {
        cwd: channel.cwd,
        branch: channel.gitBranch,
        currentId: channel.agentId,
        sameProject,
      }),
    [sessions, filters, channel.cwd, channel.gitBranch, channel.agentId, sameProject],
  )

  // Resolve identity to a position once per render. A cursor whose session is
  // gone — deleted, filtered out, or never there — falls to the first
  // selectable row rather than to nothing, so the list is never unusable.
  const focus = React.useMemo(() => {
    const byId = view.rows.findIndex(row => row.kind === 'session' && row.session.id === focusId)
    return byId >= 0 ? byId : Math.max(0, seekSelectable(view.rows, 0, 1))
  }, [view.rows, focusId])

  const focused = sessionAt(view.rows, focus)

  // Where the cursor is RIGHT NOW, including moves made earlier in this same
  // tick. A held arrow key (or a paste) delivers several key events from one
  // stdin chunk, and every one of them runs before React re-renders — so a
  // handler that read the position from the render closure would compute all
  // of them from the same starting row and keep only the last, silently
  // dropping every move but one.
  const focusRef = React.useRef(focus)
  focusRef.current = focus

  /** Move the cursor by rows, then store the session it landed on. */
  const step = (by: 1 | -1, times = 1): void => {
    let next = focusRef.current
    for (let taken = 0; taken < times; taken++) next = moveSelection(view.rows, next, by)
    focusRef.current = next
    const landed = sessionAt(view.rows, next)
    if (landed !== undefined) setFocusId(landed.id)
  }

  // Preview follows the cursor. Keyed on the id so arrowing past a row does
  // not refetch the one it came from, and guarded on unmount so a slow read
  // landing after the cursor moved cannot overwrite a newer preview.
  React.useEffect(() => {
    if (!previewOpen || focused === undefined) return
    let live = true
    setPreviewLoading(true)
    void channel.previewSession(focused.id).then((entries) => {
      if (!live) return
      setPreview(entries)
      setPreviewLoading(false)
    })
    return () => {
      live = false
    }
  }, [channel, previewOpen, focused?.id])

  // Wide terminals put the preview beside the list; narrow ones put it in the
  // list's place. Tab must always visibly do something — a preview that
  // silently declines to appear below some width is a dead key.
  const splitPreview = previewOpen && columns >= SPLIT_MIN_COLUMNS
  const soloPreview = previewOpen && columns < SPLIT_MIN_COLUMNS
  const previewWidth = splitPreview ? Math.min(56, Math.floor(columns * 0.42)) : columns
  const listWidth = Math.max(20, columns - (splitPreview ? previewWidth : 0))
  const modeLines = mode === 'list' ? 0 : 1
  const listHeight = Math.max(2, rows - CHROME_LINES - modeLines)

  const windowTop = anchorTop(view.rows, focus, listHeight, topRef.current)
  topRef.current = windowTop
  const visible = view.rows.slice(windowTop, windowEnd(view.rows, windowTop, listHeight))

  /**
   * Change the view.
   *
   * Takes a function of the CURRENT filters rather than a ready-made patch,
   * for the same reason the cursor keeps a ref: several key events can be
   * handled before React re-renders, and a patch built from the render
   * closure would compute each of them from the same starting filters — two
   * toggles in one chunk cancelling to one, or typed characters overwriting
   * each other instead of accumulating.
   */
  const applyFilters = (update: (current: BrowserFilters) => Partial<BrowserFilters>): void => {
    setFilters(current => ({ ...current, ...update(current) }))
    topRef.current = 0
  }

  const runDelete = (target: SessionSummary): void => {
    void (async () => {
      const ok = await channel.deleteSession(target.id)
      channel.notify(
        ok
          ? t('resume-deleted', { name: target.title.text })
          : t('resume-delete-failed', { name: target.title.text }),
        ok ? {} : { color: 'error' },
      )
      await reload()
    })()
  }

  const runClean = (): void => {
    const ids = view.emptyIds
    void (async () => {
      let removed = 0
      for (const id of ids) {
        if (await channel.deleteSession(id)) removed += 1
      }
      channel.notify(t('session-cleaned', { n: removed }))
      await reload()
    })()
  }

  const runRename = (target: SessionSummary, title: string): void => {
    void (async () => {
      const ok = await channel.renameSessionTo(target.id, title)
      channel.notify(
        ok ? t('rename-done', { title }) : t('resume-rename-failed', { name: target.title.text }),
        ok ? {} : { color: 'error' },
      )
      await reload()
    })()
  }

  useInput((input, key) => {
    if (mode === 'confirm-delete') {
      if (isPlainReturn(key)) {
        setMode('list')
        if (focused !== undefined) runDelete(focused)
      } else if (key.escape) {
        setMode('list')
      }
      return
    }
    if (mode === 'confirm-clean') {
      if (isPlainReturn(key)) {
        setMode('list')
        runClean()
      } else if (key.escape) {
        setMode('list')
      }
      return
    }
    if (mode === 'rename') {
      if (isPlainReturn(key)) {
        setMode('list')
        const title = renameText.trim()
        if (focused !== undefined && title.length > 0) runRename(focused, title)
      } else if (key.escape) {
        setMode('list')
      } else if (key.backspace || key.delete) {
        setRenameText(text => text.slice(0, -1))
      } else if (!isMod(key) && !key.meta && input) {
        setRenameText(text => text + input.replace(/[\r\n]+/g, ' '))
      }
      return
    }

    if (key.upArrow) {
      step(-1)
    } else if (key.downArrow) {
      step(1)
    } else if (key.pageUp || key.pageDown) {
      // A page is "as many rows as the window holds", taken as repeated single
      // steps so it lands on a selectable row like every other move.
      step(key.pageDown ? 1 : -1, Math.max(1, Math.floor(listHeight / 2)))
    } else if (isPlainReturn(key)) {
      if (focused === undefined) return
      const target = focused
      onClose()
      void channel.resumeTo(target.id).then((ok) => {
        if (ok) channel.notify(t('resume-resumed'))
      })
    } else if (key.escape) {
      // Esc backs out one layer at a time: a live query first, the screen
      // second. Closing on the first Esc would discard a search the user is
      // still refining.
      if (filters.query.length > 0) applyFilters(() => ({ query: '' }))
      else onClose()
    } else if (key.tab) {
      setPreviewOpen(open => !open)
    } else if (isMod(key) && input === 'a') {
      applyFilters(current => ({ allProjects: !current.allProjects }))
    } else if (isMod(key) && input === 'b') {
      applyFilters(current => ({ branchOnly: !current.branchOnly }))
    } else if (isMod(key) && input === 's') {
      applyFilters(current => ({ showSubagents: !current.showSubagents }))
    } else if (isMod(key) && input === 'r' && focused !== undefined) {
      setRenameText(focused.title.text)
      setMode('rename')
    } else if (isMod(key) && input === 'd' && focused !== undefined) {
      setMode('confirm-delete')
    } else if (isMod(key) && input === 'x' && view.emptyCount > 0) {
      setMode('confirm-clean')
    } else if (key.backspace || key.delete) {
      applyFilters(current => ({ query: current.query.slice(0, -1) }))
    } else if (!isMod(key) && !key.meta && !key.super && input && !key.return) {
      // Only real characters reach the query. Anything else the terminal
      // delivers — an unbound control byte, a chord this screen does not
      // claim, the newlines inside a paste — would otherwise be typed into
      // the search box invisibly, leaving a filter that matches nothing for
      // no reason the user can see.
      const typed = input.replace(/\p{Cc}/gu, '')
      if (typed.length > 0) applyFilters(current => ({ query: current.query + typed }))
    }
  })

  const counts: string[] = []
  counts.push(t('session-count-shown', { n: view.shown }))
  if (view.hiddenSubagents > 0) counts.push(t('session-count-subagents', { n: view.hiddenSubagents }))
  if (view.emptyCount > 0) counts.push(t('session-count-empty', { n: view.emptyCount }))
  const heading = t('resume-title')
  const summary = counts.join(' · ')
  // The header is laid out as one pre-measured line rather than a flex row:
  // at an exact fit, flex truncation eats a character and the row reflows,
  // which pushes every region below it down by one.
  const gap = Math.max(1, columns - 1 - heading.length - summary.length)
  const scope = filters.allProjects
    ? t('session-scope-all')
    : formatProject(channel.cwd, home)

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexShrink={0}>
        <Text color="remember" bold>{` ${heading}`}</Text>
        <Text dimColor>{`${' '.repeat(gap)}${truncateWidth(summary, Math.max(0, columns - 2 - heading.length))}`}</Text>
      </Box>
      <Box flexShrink={0}>
        <Divider width={columns} />
      </Box>
      <Box flexShrink={0}>
        <SearchBox
          query={filters.query}
          isFocused={mode === 'list'}
          isTerminalFocused={isTerminalFocused}
          placeholder={t('session-search-placeholder', { scope })}
          borderless
        />
      </Box>
      <Box flexShrink={0}>
        <Divider width={columns} />
      </Box>

      <Box flexGrow={1} flexShrink={1}>
        {!soloPreview && (
        <Box flexDirection="column" width={listWidth} height={listHeight} flexShrink={0}>
          {!loaded && <Text dimColor italic>{` ${t('session-loading')}`}</Text>}
          {loaded && view.rows.length === 0 && (
            <Text dimColor italic>{` ${t('resume-none-in-cwd')}`}</Text>
          )}
          {visible.map((row, index) =>
            row.kind === 'project' ? (
              <Box key={`project:${row.project}:${index}`} flexShrink={0}>
                <Text color="planMode">
                  {truncateWidth(` ${formatProject(row.project, home)}`, listWidth - 6)}
                </Text>
                <Text dimColor>{`  ${row.count}`}</Text>
              </Box>
            ) : (
              <SessionListRow
                key={row.session.id}
                session={row.session}
                width={listWidth}
                depth={row.depth}
                focused={windowTop + index === focus}
                now={now}
              />
            ),
          )}
        </Box>
        )}
        {(splitPreview || soloPreview) && focused !== undefined && (
          <SessionPreview
            session={focused}
            entries={preview}
            loading={previewLoading}
            width={previewWidth}
            height={listHeight}
            home={home}
            now={now}
          />
        )}
      </Box>

      {mode === 'confirm-delete' && focused !== undefined && (
        <Box flexShrink={0}>
          <Text color="error">{` ${t('resume-delete-confirm', { name: focused.title.text })}`}</Text>
        </Box>
      )}
      {mode === 'confirm-clean' && (
        <Box flexShrink={0}>
          <Text color="warning">{` ${t('session-clean-confirm', { n: view.emptyCount })}`}</Text>
        </Box>
      )}
      {mode === 'rename' && (
        <Box flexShrink={0}>
          <SearchBox
            query={renameText}
            isFocused
            isTerminalFocused={isTerminalFocused}
            placeholder={t('resume-rename-placeholder')}
            prefix="✎"
            borderless
          />
        </Box>
      )}

      <Box flexShrink={0}>
        <Divider width={columns} />
      </Box>
      <Box flexShrink={0}>
        <Text dimColor italic>
          <HintLine
            text={
              mode === 'confirm-delete'
                ? t('resume-hint-delete')
                : mode === 'confirm-clean'
                  ? t('resume-hint-delete')
                  : mode === 'rename'
                    ? t('resume-hint-rename')
                    : t('session-hint-list', {
                      mod: modLabel,
                      projects: filters.allProjects ? t('session-toggle-on') : t('session-toggle-off'),
                      runs: filters.showSubagents ? t('session-toggle-on') : t('session-toggle-off'),
                    })
            }
          />
        </Text>
      </Box>
    </Box>
  )
}
