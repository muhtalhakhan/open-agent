# @open-agent/tools-todo

`todo_write`: a checklist the agent keeps for work with several steps. It writes the plan, marks one step `in_progress` before starting it and `done` after, and adds steps it discovers — and the person watching sees where it is.

```ts
import { todoWriteTool, trackTodos, formatTodos } from '@open-agent/tools-todo'

tools.register(todoWriteTool())
sessions.onAppend(trackTodos((taskId, todos) => console.log(formatTodos(todos))))
```

## The tool

`{ todos: [{ content, status }] }`, where `status` is `pending`, `in_progress` or `done`. Each call sends the whole list and replaces the last one. At most one item can be `in_progress`, so the list always says where the work is; up to 50 items of up to 300 characters. The result is the list as a checklist with progress: `Todo list (1/3 done):` then `[x]`, `[>]` and `[ ]` lines.

It is `safe`: it changes nothing outside the conversation.

## Where the list lives

In the session log, as the arguments of each `todo_write` call — the tool itself keeps no state. `trackTodos` follows the log and reports a task's list each time a call succeeds (a refused one changes nothing), so every view is a projection of the same record: the CLI prints the list as it changes, and the web UI draws it at the top of the turn, live and in History alike.

In the CLI it is on by default; `TODO_TOOL=0` turns it off.
