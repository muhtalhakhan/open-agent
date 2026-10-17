# web

A chat UI for the agent in your browser: send a task, watch the reply and its tool calls as they happen, stop it. **History** lists past tasks from this and earlier sessions and reopens any of them as a read-only transcript.

```bash
npm run web          # builds the client, then runs `open-agent web`
```

The server prints an address with a token in it, like `http://127.0.0.1:7373/?token=…`. Open that one: the page needs the token to talk to the agent, and moves it out of the address bar once it has it. A restart makes a new token, so reopen the address from the terminal after one.

`open-agent web` takes the same configuration as the CLI (`.env`, `init`), and `--port <n>` and `--yes` work as they do there. Ctrl+C stops the server, waiting for a running task first, and saves the session so `open-agent --resume` can continue it.

## What it can't do yet

- **Approve a tool call.** The page has nowhere to ask yet (#109), so calls that need approval are denied as in print mode, and the chat says which one and why. Start with `--yes` to allow `ask`-level calls. `--plan` is refused for the same reason.
- **Hand the browser or screen to you.** The takeover tools are not mounted in this mode.
- **Remember earlier messages in the conversation.** Each message is its own task, exactly as in the terminal REPL; recalled memories carry context across them when a memory provider is set up.

## How it fits together

- `src/server.ts` is a `node:http` server on 127.0.0.1. The CLI builds the agent (tools, sandbox, memory) and hands the server a `runTask` function, so the browser runs the same task the terminal would.
- `GET /api/events` is a server-sent event stream of everything in `src/protocol.ts`. Each connection starts with `hello` and a replay, so a reload or a second tab shows the whole conversation.
- `POST /api/tasks` starts a task (one at a time), and `POST /api/tasks/:id/cancel` stops it.
- `GET /api/history` lists past tasks (saved sessions plus the running one, as `:history` does), and `GET /api/history/:task?session=<id>` returns one task's transcript. The transcript is replayed from its session log as the same events the live stream sends, so the **History** view draws a past task exactly as the chat drew it live.
- `src/client/` is the React app, built by Vite into `dist/client/`, which the server serves.

The agent behind this page may have a shell, so the server assumes the browser also has hostile sites open. Every API call needs the token, the `Host` header must name the server (against DNS rebinding), and POSTs must be JSON from the page's own origin. The page itself loads nothing from elsewhere and cannot be framed.

## Developing the client

```bash
npm run cli -- web           # the server, on port 7373
npm run dev -w @open-agent/web
```

Vite serves the client with hot reload and proxies `/api` to the server; set `OPEN_AGENT_WEB_PORT` if it isn't on 7373. Open the Vite address with the `?token=…` the server printed.
