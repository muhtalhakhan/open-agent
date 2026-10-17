# web

A chat UI for the agent in your browser: send a task, watch the reply and its tool calls as they happen, approve or deny the calls that need it, stop it. **History** lists past tasks from this and earlier sessions and reopens any of them as a read-only transcript. **Memory** shows what the agent remembers for you, and lets you edit or forget any of it. **Settings** changes the model, API keys, search, memory, Jev and the browser tools without editing `.env` by hand.

```bash
npm run web          # builds the client, then runs `open-agent web`
```

The server prints an address with a token in it, like `http://127.0.0.1:7373/?token=…`. Open that one: the page needs the token to talk to the agent, and moves it out of the address bar once it has it. A restart makes a new token, so reopen the address from the terminal after one.

`open-agent web` takes the same configuration as the CLI (`.env`, `init`), and `--port <n>`, `--yes` and `--plan` work as they do there. Ctrl+C stops the server, waiting for a running task first, and saves the session so `open-agent --resume` can continue it.

## What it can't do yet

- **Hand the browser or screen to you.** The takeover tools are not mounted in this mode.
- **Remember earlier messages in the conversation.** Each message is its own task, exactly as in the terminal REPL; recalled memories carry context across them when a memory provider is set up.

## How it fits together

- `src/server.ts` is a `node:http` server on 127.0.0.1. The CLI builds the agent (tools, sandbox, memory) and hands the server a `runTask` function, so the browser runs the same task the terminal would.
- `GET /api/events` is a server-sent event stream of everything in `src/protocol.ts`: the reply as it is written, each step of the turn, provider retries, tool calls with what they returned, decision-layer choices and approvals. All but the text come from one projection of the session log (`activityProjector` in `src/project.ts`), shared with the history replay, so a task reads the same live and afterwards. The page shows them as step dividers, a one-line status ("Step 3 · running `read_file`…"), retry notes, and tool rows that expand to their output. Each connection starts with `hello` and a replay, so a reload or a second tab shows the whole conversation.
- `POST /api/tasks` starts a task (one at a time), and `POST /api/tasks/:id/cancel` stops it.
- A call that needs approval arrives as an `approval/request` event, drawn as a card in the turn: the tool, its arguments (or, with `--plan`, the diff of the change) and why it is being asked about if a sequence rule held it. The answer goes to `POST /api/approvals/:id`. The choices are the terminal's, from `approvalScopes` in `@open-agent/agent` — once, for this task, or always this session (confirmed with a second click) — narrowed for `dangerous` calls, held calls and plan reviews. The server refuses any scope it did not offer. A pending question is replayed to a tab that connects late, and stopping the task or the server denies it, so the agent never waits on a question nobody can see.
- `GET /api/history` lists past tasks (saved sessions plus the running one, as `:history` does), and `GET /api/history/:task?session=<id>` returns one task's transcript. The transcript is replayed from its session log as the same events the live stream sends, so the **History** view draws a past task exactly as the chat drew it live.
- `GET /api/memory?q=` lists the memories of the user tasks run as (`CLI_USER_ID`, default `cli-user`), or searches them; `POST /api/memory/:id` edits one and `POST /api/memory/:id/forget` forgets it. The CLI hands the server a `MemorySource` already scoped to that container, so the page cannot reach anyone else's. Listing everything needs the provider's optional `list()` (in-memory and mem0 have it); Supermemory can only search, and the view says so instead of looking empty. mem0 cannot edit, and the view reports that when an edit is refused.
- `GET /api/settings` and `POST /api/settings` read and change the CLI's configuration through a `SettingsSource` (`apps/cli/src/settings.ts`). Only an allowlist of settings can be changed: the model, its key and light model, the search, memory and TypeSafe keys, the decision layer and the browser tools. The shell, its sandbox, the file workspace and a shared browser profile decide how much of the machine and your accounts the agent reaches, and stay with `open-agent init` and `.env`. A key's value never comes back to the page, only whether it is set and where. New keys go to the OS keychain when `SECRET_STORE=keychain`, otherwise to `.env` (mode 0600), which is edited in place, keeping your comments and every setting the page does not manage. The whole result is checked with the config loader before anything is written, so a change that would stop the agent starting is refused. A variable set in the shell is shown read-only, since `.env` cannot override it. Saved changes apply on restart, and the page says so.
- With the browser tools on, the page shows what the browser shows: after each action that changes the page, a screenshot arrives as a `screen` event and replaces the turn's picture. Screenshots are display only (never logged or seen by the model), and only PNG, JPEG and WebP under about 3 MB are passed on. A tab that connects mid-task gets the latest one, and the final picture of each of the last five tasks stays with its turn. History does not have them, since they are not in the session log.
- `src/client/` is the React app, built by Vite into `dist/client/`, which the server serves.

The agent behind this page may have a shell, so the server assumes the browser also has hostile sites open. Every API call needs the token, the `Host` header must name the server (against DNS rebinding), and POSTs must be JSON from the page's own origin. The page itself loads nothing from elsewhere and cannot be framed.

## Developing the client

```bash
npm run cli -- web           # the server, on port 7373
npm run dev -w @open-agent/web
```

Vite serves the client with hot reload and proxies `/api` to the server; set `OPEN_AGENT_WEB_PORT` if it isn't on 7373. Open the Vite address with the `?token=…` the server printed.
