import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { TodoTask, TodoView } from '../types'
import { byPriority, formatDone, formatNew, lines, matches, openTasks, parseChange, tagsOf } from './todo'

const PANE = 'todo-txt'
const TODO = 'todo.txt'
const DONE = 'done.txt'

const EMPTY: TodoView = { mode: 'open', open: [], closed: [], filter: [], editing: null, last: null }
const view = atom({ plugin: 'todo-txt', key: 'view' } as const, EMPTY)

// state outlives a reload of the module: a value saved by an older version may lack fields
async function current($: EngineInterface): Promise<TodoView> {
  return { ...EMPTY, ...(await read($, view)) }
}

const SYSTEM = `You maintain a todo.txt file for a software project.
You are given the open tasks (numbered), the user's latest prompt and the assistant's answer.
Return ONLY a JSON object: {"add":[{"text":"...","priority":"A"|null}],"done":[<numbers>]}.
- "add": tasks the user asked for, or the assistant explicitly committed to or left as a follow-up, that are NOT already in the list. One short imperative line each, in the language the user writes in. Add +project or @context tags only when obvious. Priority A for urgent/blocking, B for important, otherwise null.
- "done": numbers of open tasks that this exchange explicitly reports as completed, by the user or by the assistant. Talking about a task, planning it or editing its wording does not complete it. When in doubt, leave it open.
Questions, explanations and ideas with no action are not tasks. When nothing changes, return {"add":[],"done":[]}.`

async function readFile($: EngineInterface, path: string): Promise<string> {
  return (await $.fs.exists(path)) ? $.fs.read(path) : ''
}

async function refresh($: EngineInterface, change: Partial<TodoView> = {}): Promise<TodoView> {
  const open = openTasks(await readFile($, TODO))
    .sort(byPriority)
    .map(({ line, priority, text }) => ({ line, priority, text }))
  const closed = lines(await readFile($, DONE)).map(line => line.replace(/^x /, ''))
  const next: TodoView = { ...(await current($)), open, closed, ...change }
  await update($, view, () => next)
  return next
}

async function today($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString().slice(0, 10)
}

async function sync($: EngineInterface, prompt: string, answer: string): Promise<string | null> {
  // the file is rewritten line for line: finished lines go, new ones are appended, the rest stays as it was
  const todo = (await readFile($, TODO)).split('\n')
  const open = todo.filter(line => line.trim() !== '' && !line.startsWith('x '))
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

  let text = kept.join('\n')
  if (added.length > 0) text = (text === '' || text.endsWith('\n') ? text : text + '\n') + added.join('\n') + '\n'
  await $.fs.write(TODO, text)
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

async function replaceLine($: EngineInterface, oldLine: string, newLine: string): Promise<void> {
  const todo = (await readFile($, TODO)).split('\n')
  const at = todo.indexOf(oldLine)
  if (at < 0) return
  todo[at] = newLine
  await $.fs.write(TODO, todo.join('\n'))
}

export const register: Register = on => {
  const prompts = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todo',
      description: 'Show the todo.txt pane, filter it, show done.txt, or add a task',
      argumentHint: '[done] [+project @context A word] | add <task>',
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
      await refresh($, { last: summary })
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
    const tokens = args === '' ? [] : args.split(/\s+/)
    const mode = tokens[0] === 'done' ? 'done' : 'open'
    const filter = mode === 'done' ? tokens.slice(1) : tokens
    const current = await refresh($, { mode, filter, editing: null })
    await $.ui.open({ id: PANE, title: mode === 'done' ? 'done.txt' : 'todo.txt', focus: true })
    const shown =
      mode === 'done'
        ? current.closed.filter(line => matches(line, null, filter)).length
        : current.open.filter(task => matches(task.line, task.priority, filter)).length
    const of = mode === 'done' ? current.closed.length : current.open.length
    const scope = filter.length ? ` matching ${filter.join(' ')}` : ''
    return { text: `${mode === 'done' ? DONE : TODO}: ${shown} of ${of} ${mode}${scope}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // mobile draws no Input: there the rows are read-only
    const Input = 'Input' in elements ? elements.Input : undefined
    const { mode, open, closed, filter, editing, last } = await current($)
    const color = (priority: string | null) =>
      priority === 'A' ? 'error' : priority === 'B' ? 'warning' : priority === 'C' ? 'suggestion' : 'subtle'
    const toggle = (token: string) =>
      update($, view, v => ({
        ...EMPTY,
        ...v,
        filter: (v.filter ?? []).includes(token) ? v.filter.filter(t => t !== token) : [...(v.filter ?? []), token],
      }))

    const all = mode === 'done' ? closed : open.map(task => task.line)
    const tags = [...new Set(all.flatMap(tagsOf))].sort()
    const priorities = [...new Set(open.map(task => task.priority).filter((p): p is string => p !== null))].sort()
    const chips = mode === 'done' ? tags : [...priorities, ...tags]
    const words = (text: string) =>
      text.split(/(\s+)/).map(word =>
        word.startsWith('+') ? (
          <Text color="suggestion">{word}</Text>
        ) : word.startsWith('@') ? (
          <Text color="planMode">{word}</Text>
        ) : (
          word
        ),
      )

    const filterRow = chips.length > 0 && (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {chips.map(token => (
          <Button
            key={`f:${token}`}
            label={token}
            plain
            dimColor={!filter.includes(token)}
            {...(filter.includes(token) ? { variant: 'primary' as const } : {})}
            onPress={() => void toggle(token)}
          />
        ))}
        {filter.length > 0 && (
          <Button key="f:clear" label="clear" plain onPress={() => void update($, view, v => ({ ...EMPTY, ...v, filter: [] }))} />
        )}
      </Box>
    )

    if (mode === 'done') {
      const shown = closed.filter(line => matches(line, null, filter))
      return (
        <Box flexDirection="column">
          {filterRow}
          {shown.length === 0 && <Text dimColor>No done tasks.</Text>}
          {shown.map(line => (
            <Text wrap="wrap" dimColor>
              {words(line)}
            </Text>
          ))}
          <Text dimColor>
            {shown.length} of {closed.length} done · /todo for open tasks
          </Text>
        </Box>
      )
    }

    const shown = open.filter(task => matches(task.line, task.priority, filter))
    return (
      <Box flexDirection="column">
        {filterRow}
        {shown.length === 0 && <Text dimColor>No open tasks.</Text>}
        {shown.map((task, index) =>
          Input !== undefined && task.line === editing ? (
            <Box key={`row:${index}`} flexDirection="row" columnGap={1}>
              <Input
                key="edit"
                value={task.line}
                submitLabel="save"
                autoFocus
                onSubmit={async (value: string) => {
                  const text = value.trim()
                  if (text !== '' && text !== task.line) await replaceLine($, task.line, text)
                  await refresh($, { editing: null })
                }}
              />
              <Button key="cancel" label="cancel" plain dimColor onPress={() => void refresh($, { editing: null })} />
            </Box>
          ) : (
            <Box key={`row:${index}`} flexDirection="row" columnGap={1}>
              <Text color={color(task.priority)}>{task.priority ? `(${task.priority})` : ' · '}</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="wrap">{words(task.text)}</Text>
              </Box>
              {Input !== undefined && (
                <Button
                  key={`e:${index}`}
                  label="edit"
                  plain
                  dimColor
                  onPress={() => void update($, view, v => ({ ...EMPTY, ...v, editing: task.line }))}
                />
              )}
            </Box>
          ),
        )}
        <Text dimColor>
          {shown.length} of {open.length} open · {closed.length} done
          {filter.length ? ` · filter: ${filter.join(' ')}` : ''}
          {last ? ` · last sync: ${last}` : ''}
        </Text>
      </Box>
    )
  })
}
