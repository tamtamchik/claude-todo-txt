import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { TodoView } from '../types'
import { byPriority, formatDone, formatNew, lines, openTasks, parseChange } from './todo'

const PANE = 'todo-txt'
const TODO = 'todo.txt'
const DONE = 'done.txt'

const view = atom({ plugin: 'todo-txt', key: 'view' } as const, {
  open: [],
  done: 0,
  last: null,
} as TodoView)

const SYSTEM = `You maintain a todo.txt file for a software project.
You are given the open tasks (numbered), the user's latest prompt and the assistant's answer.
Return ONLY a JSON object: {"add":[{"text":"...","priority":"A"|null}],"done":[<numbers>]}.
- "add": tasks the user asked for, or the assistant explicitly committed to or left as a follow-up, that are NOT already in the list. One short imperative line each, in the language the user writes in. Add +project or @context tags only when obvious. Priority A for urgent/blocking, B for important, otherwise null.
- "done": numbers of open tasks that this exchange shows were completed.
Questions, explanations and ideas with no action are not tasks. When nothing changes, return {"add":[],"done":[]}.`

async function readFile($: EngineInterface, path: string): Promise<string> {
  return (await $.fs.exists(path)) ? $.fs.read(path) : ''
}

async function refresh($: EngineInterface, last: string | null = null): Promise<TodoView> {
  const open = openTasks(await readFile($, TODO))
    .sort(byPriority)
    .map(({ priority, text }) => ({ priority, text }))
  const done = lines(await readFile($, DONE)).length
  const next: TodoView = { open, done, last: last ?? (await read($, view)).last }
  await update($, view, () => next)
  return next
}

async function today($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString().slice(0, 10)
}

async function sync($: EngineInterface, prompt: string, answer: string): Promise<string | null> {
  const todo = lines(await readFile($, TODO))
  const open = todo.filter(line => !line.startsWith('x '))
  const listed = open.map((line, i) => `${i + 1}. ${line}`).join('\n') || '(none)'
  const reply = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: `Open tasks:\n${listed}\n\nUser prompt:\n${prompt.slice(0, 6000)}\n\nAssistant answer:\n${answer.slice(0, 6000)}`,
    maxTokens: 1024,
    effort: 'low',
    timeoutMs: 30000,
  })
  if (!reply.isAnswered) return null
  const change = parseChange(reply.text)
  const date = await today($)
  const finished = new Set(change.done.map(n => open[n - 1]).filter((line): line is string => line !== undefined))
  const kept = todo.filter(line => !finished.has(line))
  const added = change.add.map(t => formatNew(t.text, t.priority, date))
  if (finished.size === 0 && added.length === 0) return null

  await $.fs.write(TODO, [...kept, ...added].join('\n') + '\n')
  if (finished.size > 0) {
    const done = await readFile($, DONE)
    const archived = [...finished].map(line => formatDone(line, date))
    await $.fs.write(DONE, (done.endsWith('\n') || done === '' ? done : done + '\n') + archived.join('\n') + '\n')
  }
  const parts = []
  if (added.length) parts.push(`+${added.length}`)
  if (finished.size) parts.push(`done ${finished.size}`)
  return parts.join(' ')
}

export const register: Register = on => {
  const prompts = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todo',
      description: 'Show the todo.txt pane, or add a task',
      argumentHint: '[add <task>]',
    })
    await refresh($)
    void $.ui.open({ id: PANE, title: 'todo.txt' })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) prompts.set(e.turnId, e.text)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const prompt = prompts.get(e.turnId) ?? ''
    prompts.delete(e.turnId)
    if (e.agentId !== undefined || e.reason !== 'answer' || prompt === '' || prompt.startsWith('/')) {
      return result
    }
    const summary = await sync($, prompt, e.answer)
    if (summary !== null) {
      await refresh($, summary)
      $.ui.toast(`todo.txt: ${summary}`)
    }
    return result
  })

  on('command.run', { command: 'todo' }, async ($, e) => {
    const args = e.args.trim()
    if (args.startsWith('add ')) {
      const text = args.slice(4).trim()
      const todo = await readFile($, TODO)
      const line = formatNew(text, null, await today($))
      await $.fs.write(TODO, (todo.endsWith('\n') || todo === '' ? todo : todo + '\n') + line + '\n')
      await refresh($)
      return { text: `Added: ${line}` }
    }
    const current = await refresh($)
    await $.ui.open({ id: PANE, title: 'todo.txt', focus: true })
    return { text: `todo.txt: ${current.open.length} open, ${current.done} done` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { open, done, last } = await read($, view)
    const color = (priority: string | null) =>
      priority === 'A' ? 'error' : priority === 'B' ? 'warning' : priority === 'C' ? 'suggestion' : 'subtle'

    return (
      <Box flexDirection="column">
        {open.length === 0 && <Text dimColor>No open tasks.</Text>}
        {open.map(task => (
          <Box flexDirection="row">
            <Text color={color(task.priority)}>{task.priority ? `(${task.priority})` : ' · '} </Text>
            <Text wrap="truncate-end">{task.text}</Text>
          </Box>
        ))}
        <Text dimColor>
          {open.length} open · {done} done{last ? ` · last sync: ${last}` : ''}
        </Text>
      </Box>
    )
  })
}
