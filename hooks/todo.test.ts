import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatDone, formatNew, openTasks, parseChange } from './todo'

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

// the engine hands the fs hooks an absolute path: key the fake by file name
const name = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function fakeFs(on: On, files: Map<string, string>) {
  on('fs.exists', (_, e) => ({ value: files.has(name(e.path)) }))
  on('fs.read', (_, e) => ({ value: files.get(name(e.path)) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(name(e.path), e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
}

function fakeTurns(on: On) {
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

test('parses and formats todo.txt lines', async () => {
  const open = openTasks('(A) 2026-10-01 Fix login +auth\nx 2026-10-02 2026-10-01 Old\n\nWrite docs @home\n')
  expect(open).toEqual([
    { line: '(A) 2026-10-01 Fix login +auth', priority: 'A', created: '2026-10-01', text: 'Fix login +auth' },
    { line: 'Write docs @home', priority: null, created: null, text: 'Write docs @home' },
  ])
  expect(formatNew('Add tests', 'B', '2026-10-17')).toBe('(B) 2026-10-17 Add tests')
  expect(formatDone('(A) 2026-10-01 Fix login +auth', '2026-10-17')).toBe('x 2026-10-17 2026-10-01 Fix login +auth pri:A')
  expect(parseChange('Sure: {"add":[{"text":" Deploy ","priority":"A"},{"text":""}],"done":[2,"x",0]}')).toEqual({
    add: [{ text: 'Deploy', priority: 'A' }],
    done: [2],
  })
  expect(parseChange('no json here')).toEqual({ add: [], done: [] })
})

test('turn.complete adds new tasks and archives finished ones', async ($, on) => {
  const files = new Map<string, string>([[
    'todo.txt',
    '# Backlog\n\n(A) 2026-10-01 Fix login +auth\n2026-10-02 Write docs\n',
  ]])
  fakeFs(on, files)
  fakeTurns(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 17) })
  let asked = ''
  on('model.complete', (_, e) => {
    asked = e.prompt
    return {
      value: {
        isAnswered: true as const,
        text: '{"add":[{"text":"Add tests for login","priority":"B"}],"done":[2]}',
        usage: USAGE,
      },
    }
  })

  await $.turn.start({ text: 'fix login, then add tests', turnId: 't1' })
  await $.turn.complete({
    turnId: 't1',
    answer: 'Login is fixed. Tests are next.',
    reason: 'answer',
    durationMs: 10,
    isAborted: false,
  })

  expect(asked).toContain('2. (A) 2026-10-01 Fix login +auth')
  expect(files.get('todo.txt')).toBe('# Backlog\n\n2026-10-02 Write docs\n(B) 2026-10-17 Add tests for login\n')
  expect(files.get('done.txt')).toBe('x 2026-10-17 2026-10-01 Fix login +auth pri:A\n')
})

test('a subagent turn and a slash command turn do not sync', async ($, on) => {
  let calls = 0
  fakeFs(on, new Map())
  fakeTurns(on)
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true as const, text: '{"add":[],"done":[]}', usage: USAGE } }
  })
  await $.turn.start({ text: '/compact', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', answer: 'ok', reason: 'answer', durationMs: 1, isAborted: false })
  await $.turn.start({ text: 'do it', turnId: 't3', agentId: 'agent-1' })
  await $.turn.complete({ turnId: 't3', answer: 'done', reason: 'answer', durationMs: 1, isAborted: false, agentId: 'agent-1' })
  expect(calls).toBe(0)
})

test('the pane lists open tasks by priority on each surface', async ($, on) => {
  const files = new Map<string, string>([
    ['todo.txt', '2026-10-02 Write docs\n(A) 2026-10-01 Fix login\n'],
    ['done.txt', 'x 2026-10-03 Old\n'],
  ])
  fakeFs(on, files)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'no-surface' as const } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/project', surface: null, isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'todo-txt',
      surface,
      component: 'Pane',
      requestId: 'todo-txt',
      props: {
        title: 'todo.txt',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    const texts = (await ui.findAll({ type: 'Text' })).map(row => row.text)
    expect(texts.indexOf('Fix login')).toBeLessThan(texts.indexOf('Write docs'))
    expect(texts.some(t => t.includes('2 open') && t.includes('1 done'))).toBe(true)
    await ui.unmount()
  }
})

test('/todo done switches the pane to done.txt and /todo back', async ($, on) => {
  const files = new Map<string, string>([
    ['todo.txt', '2026-10-02 Write docs\n'],
    ['done.txt', 'x 2026-10-03 2026-10-01 Fix login pri:A\n'],
  ])
  fakeFs(on, files)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  const run = (args: string) =>
    $.command.run({ command: 'todo', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const mount = () =>
    $.ui.mount({
      plugin: 'todo-txt',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'todo-txt',
      props: { title: 'todo.txt', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })

  expect((await run('done')).text).toBe('done.txt: 1 of 1 done')
  let ui = await mount()
  let texts = (await ui.findAll({ type: 'Text' })).map(row => row.text)
  expect(texts).toContain('2026-10-03 2026-10-01 Fix login pri:A')
  expect(texts.some(t => t.includes('Write docs'))).toBe(false)
  await ui.unmount()

  expect((await run('')).text).toBe('todo.txt: 1 of 1 open')
  ui = await mount()
  texts = (await ui.findAll({ type: 'Text' })).map(row => row.text)
  expect(texts).toContain('Write docs')
  await ui.unmount()
})

const PANE = {
  plugin: 'todo-txt',
  component: 'Pane',
  requestId: 'todo-txt',
  props: { title: 'todo.txt', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('filter chips and /todo tokens narrow the list', async ($, on) => {
  const files = new Map<string, string>([
    ['todo.txt', '(A) 2026-10-01 Fix login +auth @backend\n(B) 2026-10-02 Write docs +docs\n2026-10-03 Tidy up +docs @home\n'],
  ])
  fakeFs(on, files)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  const run = (args: string) =>
    $.command.run({ command: 'todo', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  expect((await run('+docs @home')).text).toBe('todo.txt: 1 of 3 open matching +docs @home')
  for (const surface of ['terminal', 'desktop'] as const) {
    await run('')
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = async () => (await ui.findAll({ type: 'Text' })).map(row => row.text)
    expect((await texts()).some(t => t.includes('Fix login'))).toBe(true)
    await ui.press({ key: 'f:+docs' })
    expect((await texts()).some(t => t.includes('Fix login'))).toBe(false)
    expect((await texts()).some(t => t.includes('Write docs'))).toBe(true)
    await ui.press({ key: 'f:B' })
    expect((await texts()).some(t => t.includes('Tidy up'))).toBe(false)
    expect((await texts()).some(t => t.includes('1 of 3 open'))).toBe(true)
    await ui.press({ key: 'f:clear' })
    expect((await texts()).some(t => t.includes('3 of 3 open'))).toBe(true)
    await ui.unmount()
  }
})

test('edit replaces one line of todo.txt in place', async ($, on) => {
  const files = new Map<string, string>([
    ['todo.txt', '# notes\n\n(A) 2026-10-01 Fix login +auth\n2026-10-02 Write docs\n'],
  ])
  fakeFs(on, files)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.command.run({ command: 'todo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // rows sorted by priority: (A) Fix login, then '# notes' and 'Write docs' in file order
    await ui.press({ key: 'e:2' })
    expect(await ui.find({ type: 'Input', key: 'edit' })).toBeDefined()
    await ui.input({ key: 'edit', text: '(B) 2026-10-02 Write docs +docs' })
    expect(files.get('todo.txt')).toBe('# notes\n\n(A) 2026-10-01 Fix login +auth\n(B) 2026-10-02 Write docs +docs\n')
    expect(await ui.find({ type: 'Input', key: 'edit' })).toBeUndefined()
    await ui.press({ key: 'e:0' })
    await ui.press({ key: 'cancel' })
    expect(await ui.find({ type: 'Input', key: 'edit' })).toBeUndefined()
    files.set('todo.txt', '# notes\n\n(A) 2026-10-01 Fix login +auth\n2026-10-02 Write docs\n')
    await $.command.run({ command: 'todo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    await ui.unmount()
  }
})

test('the pane draws over state saved by an older version of the plugin', async ($, on) => {
  fakeFs(on, new Map([['todo.txt', '(A) 2026-10-01 Fix login +auth\n']]))
  // until the plugin writes, every read answers what the previous version stored: no `filter`, no `editing`
  const stale = {
    mode: 'open',
    open: [{ line: '(A) 2026-10-01 Fix login +auth', priority: 'A', text: 'Fix login +auth' }],
    closed: [],
    last: null,
  }
  let isStale = true
  on('state.get', (_, e, next) => (isStale ? { value: { value: stale, version: 1 } } : next(e)))
  on('state.set', (_, e, next) => {
    isStale = false
    return next(e)
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = async () => (await ui.findAll({ type: 'Text' })).map(row => row.text).join(' | ')
    expect(await texts()).toContain('Fix login')
    expect(await texts()).toContain('1 of 1 open')
    await ui.unmount()
  }
})
