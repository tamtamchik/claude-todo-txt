# todo-txt for Claude Code

A Claude Code plugin that keeps a [todo.txt](https://github.com/todotxt/todo.txt) file in the project root and shows it in a pane.

After each turn, a small model (haiku) reads the user's prompt and the assistant's answer, then:

- adds the tasks the user asked for, or the assistant committed to, as new `todo.txt` lines;
- moves the tasks that the turn completed to `done.txt`.

Nothing else touches the files, so you can edit them by hand or with any todo.txt tool.

## Install

At the prompt of a terminal session:

```
/plugin install todo-txt --marketplace tamtamchik/claude-todo-txt
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install todo-txt --marketplace tamtamchik/claude-todo-txt
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `tamtamchik/claude-todo-txt`, then **Add plugin**.

## Use

- The `todo.txt` pane opens on session start when the terminal is wide enough for a sidebar. `/todo` opens or focuses it at any width.
- `/todo done` switches the pane to `done.txt`; `/todo` switches it back.
- `/todo add <task>` appends a task with today's date.
- The pane lists open tasks sorted by priority, with the count of open and done tasks and the last sync result.

Line format:

```
(A) 2026-10-17 Fix login +auth @backend
```

A completed task is moved to `done.txt` as:

```
x 2026-10-18 2026-10-17 Fix login +auth @backend pri:A
```

Only turns on the main conversation that start with a typed prompt are analysed. Slash commands and subagent runs are skipped. Each analysed turn costs one haiku call.

## Development

```
claude plugin validate .
claude plugin test .
```

Run it from this folder without installing:

```
claude --plugin-dir /path/to/claude-todo-txt
```

Files:

- `hooks/register.tsx`: the hooks (session start, turn end, `/todo`, the pane).
- `hooks/todo.ts`: todo.txt parsing and formatting, and the parser of the model's reply.
- `hooks/todo.test.ts`: tests, run with `claude plugin test`.
- `types/index.d.ts`: the plugin's state contract.
