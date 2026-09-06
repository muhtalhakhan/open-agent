#!/usr/bin/env node
/**
 * Regenerates the milestone table in README.md's "Project status" section from
 * the GitHub issue tracker, in place, between the GENERATED markers.
 *
 * Only the table is generated. The prose around it ("Recently landed",
 * "Nearest up next", the security caveat) is editorial — a merged PR cannot
 * tell you what is worth saying about it, so that stays hand-written.
 *
 * Run it locally with `npm run docs:status`; CI runs it from
 * `.github/workflows/docs-status.yml` whenever a PR merges or a branch is
 * deleted. Output is deliberately timestamp-free so an unchanged tracker
 * produces no diff and no pull request.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import prettier from 'prettier'

const BEGIN = '<!-- BEGIN GENERATED: milestone-status -->'
const END = '<!-- END GENERATED: milestone-status -->'
/** Beyond this the "what's left" cell stops being readable and starts being a list. */
const MAX_LISTED_ISSUES = 2
/** Long enough for a real issue title, short enough to keep the row scannable. */
const MAX_TITLE_CHARS = 44

/** A table cell can't carry a raw pipe, and issue titles are user-written. */
function escapeCell(text) {
  return text.replace(/\|/g, '\\|')
}

/** "Milestone 5 — Files + Terminal" is the tracker's name for what the table calls "5 — Files + Terminal". */
function shortTitle(title) {
  return title.replace(/^Milestone\s+/i, '')
}

function milestoneOrder(title) {
  const match = /^Milestone\s+(\d+)/i.exec(title)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function clip(title) {
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : title
}

function summarise(remaining) {
  const listed = remaining
    .slice(0, MAX_LISTED_ISSUES)
    .map((issue) => `${escapeCell(clip(issue.title))} (#${issue.number})`)
  const rest = remaining.length - listed.length
  return rest > 0 ? `${listed.join(', ')}, +${rest} more` : listed.join(', ')
}

/** The one editorial judgement worth automating: how close a milestone is to done. */
export function describeState(milestone) {
  const total = milestone.closed + milestone.open
  if (total === 0) return '⚪ No issues yet'
  if (milestone.open === 0) return '✅ Complete'
  const summary = summarise(milestone.remaining)
  // Nothing is done yet, so the useful thing to say is where to start, not what is left.
  if (milestone.closed === 0) return `🚧 Not started — first up: ${summary}`
  return milestone.closed / total >= 0.75 ? `🟢 Nearly done — ${summary} left` : `🟡 In progress — ${summary} left`
}

/**
 * Pure render, so the table can be tested without reaching GitHub. Column
 * padding is left to Prettier, which the writer runs over the whole file — a
 * hand-aligned table here would only be realigned there.
 */
export function renderMilestoneTable(milestones) {
  const rows = [...milestones]
    .sort((a, b) => milestoneOrder(a.title) - milestoneOrder(b.title))
    .map((milestone) => {
      const total = milestone.closed + milestone.open
      return `| ${escapeCell(shortTitle(milestone.title))} | ${milestone.closed} / ${total} | ${describeState(milestone)} |`
    })
  return ['| Milestone | Done | State |', '| --- | --- | --- |', ...rows].join('\n')
}

/** Swap the generated block, leaving every other byte of the file alone. */
export function replaceGeneratedBlock(markdown, table) {
  const start = markdown.indexOf(BEGIN)
  const end = markdown.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md is missing the ${BEGIN} / ${END} markers`)
  }
  return `${markdown.slice(0, start + BEGIN.length)}\n\n${table}\n\n${markdown.slice(end)}`
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'open-agent-docs-status',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} ${response.statusText} for ${url}`)
  }
  return response.json()
}

/** Every page of a list endpoint; the tracker is already past one page of issues. */
async function githubPaged(url, token) {
  const items = []
  for (let page = 1; page <= 20; page += 1) {
    const batch = await githubJson(`${url}&per_page=100&page=${page}`, token)
    items.push(...batch)
    if (batch.length < 100) break
  }
  return items
}

export async function fetchMilestones(repo, token) {
  const api = `https://api.github.com/repos/${repo}`
  const [milestones, issues] = await Promise.all([
    githubPaged(`${api}/milestones?state=all`, token),
    githubPaged(`${api}/issues?state=open`, token),
  ])

  return milestones.map((milestone) => ({
    title: milestone.title,
    closed: milestone.closed_issues,
    open: milestone.open_issues,
    // The issues endpoint returns pull requests too, and an open PR is not
    // outstanding work the way an open issue is.
    remaining: issues
      .filter((issue) => !issue.pull_request && issue.milestone?.number === milestone.number)
      .sort((a, b) => a.number - b.number)
      .map((issue) => ({ number: issue.number, title: issue.title })),
  }))
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? 'muhtalhakhan/open-agent'
  const readme = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md')

  const milestones = await fetchMilestones(repo, process.env.GITHUB_TOKEN)
  const before = await fs.readFile(readme, 'utf8')
  // Formatted here rather than in a separate CI step so that the comparison
  // below is against the bytes that would actually be committed — otherwise
  // Prettier's column padding makes every run look like a change.
  const after = await prettier.format(replaceGeneratedBlock(before, renderMilestoneTable(milestones)), {
    ...(await prettier.resolveConfig(readme)),
    filepath: readme,
  })

  if (before === after) {
    console.log('Milestone table already matches the tracker.')
    return
  }
  await fs.writeFile(readme, after)
  console.log(`Updated the milestone table in README.md from ${repo}.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
