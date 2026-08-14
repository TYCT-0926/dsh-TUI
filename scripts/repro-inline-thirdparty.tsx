/**
 * inline 模式第三方输出污染复现（issue #16/#10/#17 联合假设）：
 * main-screen 的 diff 引擎用相对光标记账（无 alt-screen 的每帧 CSI H 自愈），
 * 前提是"没有第三方触碰光标"。而 #17 证明真机上存在子进程直写 tty
 * （mcp-client 的 stderr 打进 UI）。本脚本在流式渲染中途向终端注入一段
 * 外部写入（模拟子进程 stderr），断言其后 UI 是否整体错位/行缺失——
 * 若断言失败，#16"label 整行消失/description 错位/header 缺失"的间歇性
 * 真机损坏即可归因于杂散输出破坏光标记账。
 * 运行：node --import tsx/esm scripts/repro-inline-thirdparty.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.CC_TUI_THEME = 'dark'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/questions.js'),
])

const COLS = 100
const ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    term.write(String(chunk), cb)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function viewportLines(): string[] {
  const buf = term.buffer.active
  const start = Math.max(0, buf.length - ROWS)
  const out: string[] = []
  for (let y = start; y < buf.length; y++) out.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  return out
}

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const listeners = new Set<() => void>()
const channel: any = {
  version: 0, rows: [] as any[], status: 'idle', sessionTitle: 'probe', agentId: 'probe',
  model: 'deepseek-v4-flash', reasoningEffort: 'max', tokens: { input: 120, output: 45 },
  cwd: '/tmp/demo', gitBranch: 'main', working: true, spinnerMode: 'requesting',
  responseChars: 0, activeToolCount: 0, turnStart: Date.now(), lastUserText: '概览',
  pending: [], commandList: [], notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

let id = 0
channel.rows.push({ id: id++, kind: 'user', text: '给我一个项目概览' })

const stdoutObj = new FakeStdout()
const instance = await render(
  <Chat channel={channel} questionStore={new QuestionStore()} />,
  { stdout: stdoutObj as any, stdin: new FakeStdin() as any, stderr: new FakeStderr() as any, exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

// 流式短回复并定格（保持帧高 < 视口，隔离"第三方输出"变量）。
const msg = { id: id++, kind: 'assistant', text: '', streaming: true }
channel.rows.push(msg); bump()
for (let i = 0; i < 12; i++) {
  msg.text += `- 概览要点第 ${i + 1} 条：模块划分与构建流程说明\n`
  bump(); await sleep(80)
}
msg.streaming = false
channel.working = false
bump()
await sleep(600)

// 对照基准：定格后的干净视口。
const golden = viewportLines()

// ★ 静止期注入第三方输出（真机 #17 场景：mcp 子进程 stderr 直写 tty，
//   打在空闲时的输入框下方——之后没有大重绘来自愈）。
term.write('\r\n[5764] Error: Non-HTTPS URLs are only allowed for localhost\r\n[35540] Usage: npx tsx proxy.ts <https://server-url>\r\n')
await sleep(100)

// 之后只有轻微 UI 活动（通知/指标 tick 级别的小 diff）——真实空闲场景。
channel.responseChars += 7; bump()
await sleep(300)
channel.responseChars += 7; bump()
await sleep(500)

const after = viewportLines()
console.log('=== 对照 diff（G=干净基准 A=注入后） ===')
let diffRows = 0
for (let y = 0; y < ROWS; y++) {
  if ((golden[y] ?? '') !== (after[y] ?? '')) {
    diffRows++
    console.log(`行${String(y).padStart(2)} G|${golden[y]}`)
    console.log(`     A|${after[y]}`)
  }
}
// 判定：注入的错误行残留在视口 = 记账破坏未自愈；UI 行内容位移 = 错位。
const strayVisible = after.some(l => l.includes('[5764] Error') || l.includes('[35540] Usage'))
const uiShifted = after.findIndex(l => l.includes('概览要点第 1 条')) !== golden.findIndex(l => l.includes('概览要点第 1 条'))
check('无第三方残留行', !strayVisible)
check('UI 行未整体位移', !uiShifted, `基准行 ${golden.findIndex(l => l.includes('概览要点第 1 条'))} → 注入后 ${after.findIndex(l => l.includes('概览要点第 1 条'))}`)
check('视口逐行一致', diffRows === 0, `${diffRows} 行不同`)

console.log(failed === 0 ? '\nALL PASS（静止期记账对第三方输出免疫）' : `\n${failed} 项失败（静止期第三方输出破坏持久化 —— #16/#17 根因候选确认）`)
await instance.unmount()
process.exit(failed === 0 ? 0 : 1)
