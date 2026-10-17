export type TodoTask = { priority: string | null; text: string }
export type TodoView = { open: TodoTask[]; done: number; last: string | null }

declare module 'claude-code' {
  interface PluginState {
    'todo-txt': { view: TodoView }
  }
}
