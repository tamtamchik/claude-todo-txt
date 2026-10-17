// todo.txt format: https://github.com/todotxt/todo.txt
//   (A) 2026-10-17 Task text +project @context
//   x 2026-10-18 2026-10-17 Task text pri:A

export type Task = { line: string; priority: string | null; created: string | null; text: string }

const OPEN = /^(?:\(([A-Z])\) )?(?:(\d{4}-\d{2}-\d{2}) )?(.+)$/

export function lines(text: string): string[] {
  return text.split(/\r?\n/).filter(line => line.trim() !== '')
}

export function parseTask(line: string): Task {
  const m = OPEN.exec(line.trim())
  if (!m) return { line, priority: null, created: null, text: line.trim() }
  return { line, priority: m[1] ?? null, created: m[2] ?? null, text: m[3] ?? '' }
}

export function openTasks(text: string): Task[] {
  return lines(text)
    .filter(line => !line.startsWith('x '))
    .map(parseTask)
}

export function formatNew(text: string, priority: string | null, today: string): string {
  const pri = priority && /^[A-Z]$/.test(priority) ? `(${priority}) ` : ''
  return `${pri}${today} ${text.trim()}`
}

export function formatDone(line: string, today: string): string {
  const { priority, created, text } = parseTask(line)
  const stamp = created ? `${today} ${created}` : today
  const pri = priority ? ` pri:${priority}` : ''
  return `x ${stamp} ${text}${pri}`
}

export function byPriority(a: Task, b: Task): number {
  const pa = a.priority ?? '~'
  const pb = b.priority ?? '~'
  return pa < pb ? -1 : pa > pb ? 1 : 0
}

export type Change = { add: { text: string; priority: string | null }[]; done: number[] }

export function parseChange(reply: string): Change {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  const empty: Change = { add: [], done: [] }
  if (start < 0 || end <= start) return empty
  let raw: unknown
  try {
    raw = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return empty
  }
  if (typeof raw !== 'object' || raw === null) return empty
  const obj = raw as { add?: unknown; done?: unknown }
  const add = Array.isArray(obj.add)
    ? obj.add
        .filter((t): t is { text: string; priority?: unknown } =>
          typeof t === 'object' && t !== null && typeof (t as { text?: unknown }).text === 'string')
        .map(t => ({
          text: t.text.trim(),
          priority: typeof t.priority === 'string' && /^[A-Z]$/.test(t.priority) ? t.priority : null,
        }))
        .filter(t => t.text !== '')
    : []
  const done = Array.isArray(obj.done)
    ? obj.done.filter((n): n is number => Number.isInteger(n) && (n as number) > 0)
    : []
  return { add, done }
}

// Filters: `+project` and `@context` match a word of the line, a single capital
// letter matches the priority, anything else is a case-insensitive substring.
export function tagsOf(line: string): string[] {
  return line.split(/\s+/).filter(word => /^[+@]\S+$/.test(word))
}

export function matches(line: string, priority: string | null, tokens: string[]): boolean {
  return tokens.every(token => {
    if (/^[+@]/.test(token)) return tagsOf(line).includes(token)
    if (/^[A-Z]$/.test(token)) return priority === token
    return line.toLowerCase().includes(token.toLowerCase())
  })
}
