import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Plain git for setting up, with the person's global hooks kept out of the way. */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', `core.hooksPath=${os.devNull}`, ...args], { cwd, encoding: 'utf8' })
}

export function makeRepo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-git-')))
  sh(root, 'init', '--quiet', '--initial-branch=main')
  sh(root, 'config', 'user.name', 'Test')
  sh(root, 'config', 'user.email', 'test@example.com')
  sh(root, 'config', 'commit.gpgSign', 'false')
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n')
  sh(root, 'add', 'README.md')
  sh(root, 'commit', '--quiet', '-m', 'first')
  return root
}
