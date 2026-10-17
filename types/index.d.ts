export type TodoTask = { priority: string | null; text: string }
export type TodoView = { mode: 'open' | 'done'; open: TodoTask[]; closed: string[]; last: string | null }

declare module 'claude-code' {
  interface PluginState {
    'todo-txt': { view: TodoView }
  }
}
