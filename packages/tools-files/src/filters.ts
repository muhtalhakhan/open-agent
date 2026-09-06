/**
 * What a filesystem tool walks past by default, and how a model's glob turns
 * into something to match with. Shared by `list_directory` and `search_files`
 * so the two agree on what "the workspace" looks like — a search that found
 * matches in a directory the listing never showed would be its own kind of
 * confusing.
 */

/** Names that are almost never what the model is looking for, and enormous when they are not. */
export const NOISY_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'coverage',
])

/** Dot-files and vendor/build directories are hidden unless the caller asks for everything. */
export function shouldSkip(name: string, all: boolean): boolean {
  if (all) return false
  return name.startsWith('.') || NOISY_DIRECTORIES.has(name)
}

/**
 * Translates a glob into an anchored regex.
 *
 * Deliberately the small, familiar subset rather than a full glob
 * implementation: `*` matches within one path segment, a doubled `*` crosses
 * segments, `?` matches one character, and everything else is literal. That
 * covers the two patterns a model actually writes — `*.ts`, and a recursive
 * one rooted at a directory — without taking on a dependency or a
 * brace-expansion parser.
 */
export function globToRegExp(glob: string, caseSensitive: boolean): RegExp {
  let pattern = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` should also match zero directories, so `**/x.ts` finds a
        // top-level x.ts — otherwise the model has to write the pattern twice.
        if (glob[index + 2] === '/') {
          pattern += '(?:.*/)?'
          index += 2
        } else {
          pattern += '.*'
          index += 1
        }
      } else {
        pattern += '[^/]*'
      }
    } else if (char === '?') {
      pattern += '[^/]'
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${pattern}$`, caseSensitive ? '' : 'i')
}
