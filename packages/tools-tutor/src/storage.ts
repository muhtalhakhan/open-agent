import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeckMetadata, Flashcard, QuizQuestion, SavedDeckFile, TutorProgressSummary } from './types.js'

export const TUTOR_DIR = '.openagent/tutor'

export function getTutorDir(workspaceRoot: string): string {
  return join(workspaceRoot, TUTOR_DIR)
}

export function sanitizeTopic(topic: string): string {
  return topic
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function saveDeck(
  workspaceRoot: string,
  topic: string,
  data: {
    title: string
    summary: string
    description?: string
    sourceFile?: string
    flashcards: Array<{ id?: string; question: string; answer: string; hint?: string; tags?: readonly string[] }>
    quizQuestions: Array<{
      id?: string
      question: string
      options?: readonly string[]
      answer: string
      explanation?: string
    }>
  },
): Promise<{ summaryPath: string; deckPath: string; topic: string }> {
  const cleanTopic = sanitizeTopic(topic)
  if (!cleanTopic) {
    throw new Error(`Invalid topic name: "${topic}". Must contain letters or numbers.`)
  }

  const dir = getTutorDir(workspaceRoot)
  await mkdir(dir, { recursive: true })

  const now = new Date().toISOString()
  const summaryFile = `${cleanTopic}-summary.md`
  const deckFile = `${cleanTopic}-deck.json`

  const summaryPath = join(dir, summaryFile)
  const deckPath = join(dir, deckFile)

  // Check if existing deck exists to preserve historical stats
  let existingDeck: SavedDeckFile | null = null
  try {
    const raw = await readFile(deckPath, 'utf8')
    existingDeck = JSON.parse(raw) as SavedDeckFile
  } catch {
    // ignore missing or corrupt file
  }

  const existingCardsMap = new Map<string, Flashcard>()
  if (existingDeck?.flashcards) {
    for (const card of existingDeck.flashcards) {
      existingCardsMap.set(card.id, card)
    }
  }

  const existingQuizMap = new Map<string, QuizQuestion>()
  if (existingDeck?.quizQuestions) {
    for (const q of existingDeck.quizQuestions) {
      existingQuizMap.set(q.id, q)
    }
  }

  const flashcards: Flashcard[] = data.flashcards.map((c, idx) => {
    const id = c.id || `card-${idx + 1}`
    const prev = existingCardsMap.get(id)
    return {
      id,
      question: c.question,
      answer: c.answer,
      hint: c.hint,
      tags: c.tags,
      attempts: prev?.attempts ?? 0,
      correctCount: prev?.correctCount ?? 0,
      lastReviewedAt: prev?.lastReviewedAt,
      lastResult: prev?.lastResult,
    }
  })

  const quizQuestions: QuizQuestion[] = data.quizQuestions.map((q, idx) => {
    const id = q.id || `quiz-${idx + 1}`
    const prev = existingQuizMap.get(id)
    return {
      id,
      question: q.question,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
      attempts: prev?.attempts ?? 0,
      correctCount: prev?.correctCount ?? 0,
      lastReviewedAt: prev?.lastReviewedAt,
      lastResult: prev?.lastResult,
    }
  })

  const metadata: DeckMetadata = {
    topic: cleanTopic,
    title: data.title || cleanTopic,
    description: data.description,
    sourceFile: data.sourceFile,
    createdAt: existingDeck?.metadata?.createdAt || now,
    updatedAt: now,
  }

  const deckPayload: SavedDeckFile = {
    version: 1,
    metadata,
    flashcards,
    quizQuestions,
  }

  // Format summary with frontmatter
  const summaryContent = [
    '---',
    `topic: ${cleanTopic}`,
    `title: ${JSON.stringify(data.title || cleanTopic)}`,
    data.sourceFile ? `sourceFile: ${JSON.stringify(data.sourceFile)}` : null,
    `updatedAt: ${now}`,
    '---',
    '',
    `# ${data.title || cleanTopic}`,
    '',
    data.summary.trim(),
    '',
  ]
    .filter((line) => line !== null)
    .join('\n')

  await writeFile(summaryPath, summaryContent, 'utf8')
  await writeFile(deckPath, JSON.stringify(deckPayload, null, 2), 'utf8')

  return { summaryPath, deckPath, topic: cleanTopic }
}

export async function loadDeck(workspaceRoot: string, topic: string): Promise<SavedDeckFile | null> {
  const cleanTopic = sanitizeTopic(topic)
  const dir = getTutorDir(workspaceRoot)
  const deckPath = join(dir, `${cleanTopic}-deck.json`)
  try {
    const content = await readFile(deckPath, 'utf8')
    return JSON.parse(content) as SavedDeckFile
  } catch {
    return null
  }
}

export async function loadSummary(workspaceRoot: string, topic: string): Promise<string | null> {
  const cleanTopic = sanitizeTopic(topic)
  const dir = getTutorDir(workspaceRoot)
  const summaryPath = join(dir, `${cleanTopic}-summary.md`)
  try {
    return await readFile(summaryPath, 'utf8')
  } catch {
    return null
  }
}

export async function saveDeckFile(workspaceRoot: string, deck: SavedDeckFile): Promise<void> {
  const dir = getTutorDir(workspaceRoot)
  await mkdir(dir, { recursive: true })
  const deckPath = join(dir, `${deck.metadata.topic}-deck.json`)
  await writeFile(deckPath, JSON.stringify(deck, null, 2), 'utf8')
}

export async function listDecks(workspaceRoot: string): Promise<DeckMetadata[]> {
  const dir = getTutorDir(workspaceRoot)
  try {
    const files = await readdir(dir)
    const deckFiles = files.filter((f) => f.endsWith('-deck.json'))
    const decks: DeckMetadata[] = []

    for (const file of deckFiles) {
      try {
        const raw = await readFile(join(dir, file), 'utf8')
        const parsed = JSON.parse(raw) as SavedDeckFile
        if (parsed?.metadata) {
          decks.push(parsed.metadata)
        }
      } catch {
        // Skip corrupted files
      }
    }
    return decks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

export function computeProgress(deck: SavedDeckFile): TutorProgressSummary {
  const totalCards = deck.flashcards.length
  const totalQuizzes = deck.quizQuestions.length
  const allItems = [...deck.flashcards, ...deck.quizQuestions]

  const reviewed = allItems.filter((item) => item.attempts > 0)
  const missed = allItems.filter((item) => item.lastResult === 'missed')
  const mastered = allItems.filter((item) => item.correctCount >= 2 && item.lastResult === 'correct')

  const totalAttempts = allItems.reduce((acc, curr) => acc + curr.attempts, 0)
  const totalCorrect = allItems.reduce((acc, curr) => acc + curr.correctCount, 0)
  const accuracyRate = totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) : 0

  let latestReviewedAt: string | undefined
  for (const item of allItems) {
    if (item.lastReviewedAt) {
      if (!latestReviewedAt || item.lastReviewedAt > latestReviewedAt) {
        latestReviewedAt = item.lastReviewedAt
      }
    }
  }

  return {
    topic: deck.metadata.topic,
    title: deck.metadata.title,
    totalCards,
    totalQuizzes,
    reviewedCards: reviewed.length,
    masteredCards: mastered.length,
    missedCards: missed.length,
    accuracyRate,
    lastReviewedAt: latestReviewedAt,
  }
}
