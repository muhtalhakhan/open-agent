# @open-agent/tools-git

Git as tools, so the agent can see the repository's state before it edits and commit its own work when asked: `git_status`, `git_diff` and `git_log` read; `git_commit` and `git_branch` change things.

## Usage

```ts
import { openWorkspace } from '@open-agent/tools-files'
import { mountGitTools } from '@open-agent/tools-git'

const workspace = await openWorkspace({ root: process.cwd() })
const dispose = mountGitTools(tools, workspace)
```

In the CLI, set `GIT_TOOL=1`. The tools use the same workspace and file policy as the file tools (`FILES_ROOT`, `FILES_DENY`, …), and the workspace has to be the top level of a repository.

## The tools

| Tool         | Level  | Does                                                                                                                               |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `git_status` | `safe` | Branch, upstream ahead/behind, staged/modified/untracked files in `git status --short` form, and the local branches                |
| `git_diff`   | `safe` | Unstaged changes, staged ones (`staged`), or the working tree against a commit (`ref`); narrowed by `path`, summarised with `stat` |
| `git_log`    | `safe` | Recent commits, one a line: hash, date, author, subject; `count`, `ref` and `path` narrow it                                       |
| `git_commit` | `ask`  | Stages `paths` (or every tracked change with `all`), then commits what is staged with `message`                                    |
| `git_branch` | `ask`  | `create` a branch (switching to it unless `switch: false`, from `start_point` if given) or `switch` to an existing one             |

`git_commit` and `git_branch` have plan-mode previews: under `--plan`, the approval shows the message and the files the commit would contain, or the branch it would create.

## What keeps it safe

Git runs on the host, outside the shell sandbox, and several of its features run programs the repository names. The sandboxed shell can write into `.git/`, so:

- **Hooks never run.** `core.hooksPath` is pointed at nothing on the command line, which outranks any config, and commits pass `--no-verify`. A check a project wires to pre-commit has to be run as a command instead.
- **No repository-chosen drivers.** The fsmonitor is off, diffs pass `--no-ext-diff --no-textconv`, and the tools refuse to run while the repository's own config sets a filter driver (`filter.*.clean`/`smudge`/`process`) or a signing program (`gpg.program`). Set in your global config — where git-lfs puts its filter — they are yours and are left alone.
- **A clean environment.** Git gets `PATH`, `HOME` and your git identity variables, nothing else, so an inherited `GIT_DIR` or `GIT_EXTERNAL_DIFF` cannot redirect it.
- **The file policy applies.** A file `read_file` may not read is left out of `git_diff` (by name, so its contents never leave git) and refused by `git_commit`, whether named, swept up by `all`, or already staged — a secret in history outlives the file. A read-only workspace refuses commits and branch changes.
- **The workspace is the repository.** Run from a subdirectory, git reports and commits the whole repository, so the tools require the workspace root to be its top level.
- **No option injection.** Refs and branch names starting with `-` are refused, branch names are checked with `git check-ref-format`, and every path goes through the workspace resolver.

## Not here

Pushing, pulling and anything else that touches a remote, merging and rebasing, and deleting branches. Each is either network access or a way to lose work, and wants its own design.
