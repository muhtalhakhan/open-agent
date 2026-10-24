# Desktop shell: Tauri + Rust vs Electron vs plain Node

An evaluation for #115. The question is whether OpenAgent should ship as a desktop app, and if so in what shell, without the choice leaking into the TypeScript agent core ([architecture.md](architecture.md#language-choice)).

**Recommendation: not yet. When it is time, Tauri 2 wrapping the existing web UI, with the agent running as a Node sidecar.** Screen capture and input injection stay in `packages/tools-computer` behind the interfaces they already have. The real gap there is Wayland, and no shell closes it.

## Where things stand

- **The agent is already hostable.** The core takes injected IO and has no UI dependencies. Since #107 it has a second host, `open-agent web`: a loopback HTTP + SSE server with a per-launch token and a React client. The page covers chat, history, approvals, live steps, memory, settings and a live browser view.
- **Computer use is already behind interfaces.** `tools-computer` drives the desktop through `@ui-tars/sdk` with the nut-js operator, as optional dependencies behind `GuiAgentFactory` and `ScreenshotOperator` (`src/types.ts`). Nothing in the core knows how a screenshot is taken.

So a desktop shell would be a third host for the same core, and almost certainly a window around the web UI that already exists. The comparison is mostly about packaging, permissions and native reach, not about UI.

## The options

### Tauri 2 (Rust core, system webview)

- **Hosting the TypeScript core:** Tauri's backend is Rust, and the core is Node. The core runs as a **sidecar**: a Node binary (a single-executable build of the CLI) that Tauri starts and stops, running `open-agent web`. The window loads the sidecar's `127.0.0.1` URL. No TypeScript has to move into Rust, and no Rust into `packages/`.
- **Size:** small. It uses the OS webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) instead of bundling Chromium. The shell is a few MB, but the Node sidecar adds tens of MB, so the total lands in the same range as a Node CLI install, well under Electron.
- **Sandboxing:** Tauri 2's capability and permission system denies the webview every native command unless it's granted per window. That suits a UI that only needs to talk to its own loopback server, and the page could have no native capabilities at all.
- **Screen capture and input:** Rust can reach each platform's APIs directly (ScreenCaptureKit and CGEvent on macOS, Windows Graphics Capture and SendInput on Windows, X11, PipeWire portals on Wayland), through crates such as `xcap` and `enigo`. This is the "better low-level access" argument from the issue. It's real, but only matters if we move capture and input out of Node. The OS permission prompts (macOS Screen Recording and Accessibility) are the same in any shell.
- **Signing and updates:** the bundler produces signed installers (`.msi`/NSIS, `.dmg` with notarization, AppImage/`.deb`/`.rpm`) and has an updater plugin. The sidecar binary has to be signed too, which is one more artefact in the pipeline.
- **Costs:** a Rust toolchain in CI and for anyone building the shell. Rendering differs between system webviews (the web UI is plain React and CSS, so the risk is low but not zero, mostly WebKitGTK on Linux). And managing the sidecar's lifecycle: start, health check, clean shutdown so sessions are saved.

### Electron (Node + bundled Chromium)

- **Hosting the TypeScript core:** natively. The main process is Node, so the core runs in-process or as a forked child, with no sidecar build. This is Electron's real advantage here.
- **Size:** large. It bundles Chromium and Node, roughly 80–150 MB installed before our own code.
- **Sandboxing:** renderer sandboxing and context isolation are good when configured, and the main process has full Node access. Since our renderer would only load the loopback page, a strict configuration is easy, but it's ours to get right rather than default-deny.
- **Screen capture and input:** `desktopCapturer` for screenshots, and still a native module (nut-js or similar) for input, since Electron has no input injection of its own. That's the same native-binding situation `tools-computer` is in today.
- **Signing and updates:** mature (electron-builder / Forge, notarization, `autoUpdater`). It's the most documented path of the three.
- **Costs:** the download size, Chromium security updates we'd have to ship promptly, and memory use.

### No shell: plain Node and the browser

- **Hosting:** `open-agent web` as it is. The user opens the printed URL.
- **Size and sandboxing:** nothing to add. The page already runs in the user's browser, with a CSP, no framing and a token.
- **Screen capture and input:** as today (nut-js via `@ui-tars/operator-nut-js`), with the same native-binding and display requirements.
- **Costs:** no tray icon, no auto-start, no native notifications, and an install that needs Node. That's fine for developers, a barrier for everyone else.

## Screen capture and input, per OS

This is the part of the issue that motivated looking at Rust. In practice the shell matters less than the OS:

| OS             | Capture                                  | Input                        | What gets in the way                                                                                                                                                                                          |
| -------------- | ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS          | ScreenCaptureKit / CGWindow              | CGEvent                      | Screen Recording and Accessibility permissions, granted per app in System Settings. A packaged app (any shell) gets a stable identity to grant them to, which is a genuine plus over a terminal running Node. |
| Windows        | Windows Graphics Capture / DXGI          | SendInput                    | Can't drive elevated (admin) windows from a normal process, the same in every shell.                                                                                                                          |
| Linux, X11     | XGetImage / XShm                         | XTest                        | Works from any process, which is what nut-js relies on.                                                                                                                                                       |
| Linux, Wayland | xdg-desktop-portal ScreenCast (PipeWire) | Portal RemoteDesktop / libei | No global capture or injection. It needs the portals and a user consent dialog. **nut-js doesn't support this today, and Rust doesn't bypass it either.** Rust only has the more mature portal clients.       |

The biggest functional gap in computer use is Wayland, now the default on most desktop Linux distributions. Closing it means implementing a `ScreenshotOperator` and an input path over the portals. That can be done in Node (D-Bus and PipeWire bindings) or as a small Rust helper process, and it's independent of the shell choice.

## How each keeps the core clean

|          | Core changes                                                           | New code lives in                                                    |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Tauri    | None: the sidecar runs the CLI's `web` mode                            | `apps/desktop` (Rust + config), plus a CI job for the sidecar binary |
| Electron | None: the main process starts the same server or calls `createRuntime` | `apps/desktop` (TypeScript)                                          |
| No shell | None                                                                   | —                                                                    |

In every case the agent sees only another host. A native capture or input helper, whichever language it's in, belongs behind `ScreenshotOperator` / `GuiAgentFactory` in `tools-computer`, never in `packages/agent`.

## Recommendation

1. **Don't build a shell now.** `open-agent web` covers the UI need, and the people running OpenAgent today are developers who already have Node. A shell adds signing, updates and a second build toolchain, but no capability the agent is missing.
2. **When packaging for non-developers becomes a goal, use Tauri 2 + a Node sidecar.** It's an order of magnitude smaller than Electron, the webview gets no native capabilities by default, and the window simply hosts the web UI we already test, so there's one UI and not two. The sidecar build is the main new work. Electron is the fallback if the sidecar's lifecycle or packaging turns out painful, since it hosts the core with no extra process.
3. **Fix Wayland in `tools-computer` regardless.** That's the computer-use limitation users will actually hit, and no shell fixes it.

### Follow-ups this suggests

- **Wayland support for computer use:** a portal-based `ScreenshotOperator` and input path (ScreenCast + RemoteDesktop), with the consent prompt surfaced through the takeover/approval flow.
- **A single-executable build of the CLI** (Node SEA or similar). It's useful without any shell (one download, no Node install), and it's the sidecar a Tauri app would need.
- **`apps/desktop` (Tauri)**, once the two above exist and there's demand from people who don't use a terminal.

Version-specific facts above (crate names, bundle sizes, API names) were current when this was written. Check them again before starting any of the follow-ups.
