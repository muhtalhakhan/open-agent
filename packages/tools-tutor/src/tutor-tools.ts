import type { ToolDefinition, ToolResult, ToolExecutionContext } from '@open-agent/agent'
import { saveDeck, loadDeck, loadSummary, listDecks, saveDeckFile, computeProgress } from './storage.js'
import type { SavedDeckFile, TutorProgressSummary } from './types.js'

export const TUTOR_SAVE_NAME = 'tutor_save'
export const TUTOR_QUIZ_NAME = 'tutor_quiz'
export const TUTOR_PROGRESS_NAME = 'tutor_progress'
export const TUTOR_LIST_NAME = 'tutor_list'

const TUTOR_SAVE_SCHEMA = {
  type: 'object',
  properties: {
    topic: {
      type: 'string',
      description: 'Kebab-case topic identifier (e.g. "typescript-generics", "react-hooks").',
    },
    title: {
      type: 'string',
      description: 'Human-readable title for this study deck.',
    },
    summary: {
      type: 'string',
      description: 'Comprehensive Markdown summary of the material.',
    },
    description: {
      type: 'string',
      description: 'Optional brief subtitle or description.',
    },
    sourceFile: {
      type: 'string',
      description: 'Optional source file or URL the material was derived from.',
    },
    flashcards: {
      type: 'array',
      description: 'List of flashcards for active recall.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique identifier for the card (optional).' },
          question: { type: 'string', description: 'Flashcard question or prompt.' },
          answer: { type: 'string', description: 'Flashcard answer.' },
          hint: { type: 'string', description: 'Optional hint for the flashcard.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        },
        required: ['question', 'answer'],
      },
    },
    quizQuestions: {
      type: 'array',
      description: 'List of quiz questions to test understanding.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique identifier for the question (optional).' },
          question: { type: 'string', description: 'Quiz question text.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Multiple choice options (optional; if omitted, short answer).',
          },
          answer: { type: 'string', description: 'Correct answer.' },
          explanation: { type: 'string', description: 'Explanation of why the answer is correct.' },
        },
        required: ['question', 'answer'],
      },
    },
  },
  required: ['topic', 'title', 'summary', 'flashcards', 'quizQuestions'],
}

const TUTOR_QUIZ_SCHEMA = {
  type: 'object',
  properties: {
    topic: {
      type: 'string',
      description: 'The topic deck to quiz on.',
    },
    mode: {
      type: 'string',
      enum: ['flashcards', 'quiz', 'missed'],
      description: 'Review mode: "flashcards" for active recall, "quiz" for questions, "missed" for weak-point retry.',
    },
    answers: {
      type: 'array',
      description: 'Optional list of user answers for grading in one shot: [{id, result: "correct" | "missed"} or {id, answer: "..."}].',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Card or question ID.' },
          result: { type: 'string', enum: ['correct', 'missed'], description: 'Self-assessed result.' },
          answer: { type: 'string', description: 'User text answer to check against correct answer.' },
        },
        required: ['id'],
      },
    },
    limit: {
      type: 'integer',
      description: 'Maximum number of items to present in this session (default 5).',
    },
  },
  required: ['topic'],
}

const TUTOR_PROGRESS_SCHEMA = {
  type: 'object',
  properties: {
    topic: {
      type: 'string',
      description: 'Optional specific topic to inspect. If omitted, returns stats for all decks.',
    },
  },
}

const TUTOR_LIST_SCHEMA = {
  type: 'object',
  properties: {},
}

export function tutorSaveTool(getWorkspaceRoot: () => string): ToolDefinition<{
  topic: string
  title: string
  summary: string
  description?: string
  sourceFile?: string
  flashcards: Array<{ id?: string; question: string; answer: string; hint?: string; tags?: string[] }>
  quizQuestions: Array<{ id?: string; question: string; options?: string[]; answer: string; explanation?: string }>
}> {
  return {
    name: TUTOR_SAVE_NAME,
    description:
      'Save study material for a topic, including a Markdown summary, flashcards for active recall, ' +
      'and quiz questions. Stored in .openagent/tutor/ as version-controlled Markdown and JSON.',
    schema: TUTOR_SAVE_SCHEMA,
    permissionLevel: 'safe',
    async execute(args): Promise<ToolResult> {
      try {
        const root = getWorkspaceRoot()
        const res = await saveDeck(root, args.topic, {
          title: args.title,
          summary: args.summary,
          description: args.description,
          sourceFile: args.sourceFile,
          flashcards: args.flashcards || [],
          quizQuestions: args.quizQuestions || [],
        })
        return {
          ok: true,
          content:
            `Successfully saved study deck for topic "${res.topic}"!\n` +
            `- Summary: ${res.summaryPath}\n` +
            `- Deck & Cards: ${res.deckPath}\n` +
            `- Flashcards: ${args.flashcards.length}\n` +
            `- Quiz Questions: ${args.quizQuestions.length}`,
        }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

export function tutorQuizTool(getWorkspaceRoot: () => string): ToolDefinition<{
  topic: string
  mode?: 'flashcards' | 'quiz' | 'missed'
  answers?: Array<{ id: string; result?: 'correct' | 'missed'; answer?: string }>
  limit?: number
}> {
  return {
    name: TUTOR_QUIZ_NAME,
    description:
      'Run a study quiz or flashcard review session for a topic. ' +
      'Without answers, returns the next batch of items to review (prioritizing missed/weak cards). ' +
      'With answers, grades them, updates mastery stats and spaced repetition history, and returns feedback.',
    schema: TUTOR_QUIZ_SCHEMA,
    permissionLevel: 'safe',
    async execute(args): Promise<ToolResult> {
      try {
        const root = getWorkspaceRoot()
        const deck = await loadDeck(root, args.topic)
        if (!deck) {
          return { ok: false, content: '', error: `Study deck for topic "${args.topic}" not found. Use tutor_save first.` }
        }

        const mode = args.mode || 'quiz'
        const limit = args.limit ?? 5

        // If grading answers
        if (Array.isArray(args.answers) && args.answers.length > 0) {
          const now = new Date().toISOString()
          const graded: string[] = []
          let correctCount = 0

          const cardMap = new Map(deck.flashcards.map((c) => [c.id, c]))
          const quizMap = new Map(deck.quizQuestions.map((q) => [q.id, q]))

          for (const ans of args.answers) {
            const card = cardMap.get(ans.id)
            const quiz = quizMap.get(ans.id)
            const target = card || quiz

            if (!target) {
              graded.push(`- Item "${ans.id}": Not found in deck`)
              continue
            }

            let isCorrect = false
            if (ans.result) {
              isCorrect = ans.result === 'correct'
            } else if (ans.answer !== undefined) {
              isCorrect = ans.answer.trim().toLowerCase() === target.answer.trim().toLowerCase()
            }

            target.attempts += 1
            target.lastReviewedAt = now
            target.lastResult = isCorrect ? 'correct' : 'missed'
            if (isCorrect) {
              target.correctCount += 1
              correctCount += 1
              graded.push(`- [CORRECT] ${ans.id}: "${target.question}"`)
            } else {
              graded.push(`- [MISSED] ${ans.id}: "${target.question}" (Correct answer: ${target.answer})`)
            }
          }

          await saveDeckFile(root, deck)
          const progress = computeProgress(deck)

          return {
            ok: true,
            content:
              `Graded ${args.answers.length} items (${correctCount} correct):\n` +
              graded.join('\n') +
              `\n\nProgress Summary: ${progress.masteredCards}/${progress.totalCards + progress.totalQuizzes} items mastered (${progress.accuracyRate}% overall accuracy). Missed queue: ${progress.missedCards} items.`,
          }
        }

        // Otherwise, serve items to review
        let pool = mode === 'flashcards' ? deck.flashcards : mode === 'quiz' ? deck.quizQuestions : [...deck.flashcards, ...deck.quizQuestions]

        if (mode === 'missed') {
          pool = pool.filter((item) => item.lastResult === 'missed' || item.attempts === 0)
        } else {
          // Prioritize unattempted or missed items
          pool = [...pool].sort((a, b) => {
            const scoreA = (a.lastResult === 'missed' ? -10 : 0) + a.attempts
            const scoreB = (b.lastResult === 'missed' ? -10 : 0) + b.attempts
            return scoreA - scoreB
          })
        }

        const selected = pool.slice(0, limit)
        if (selected.length === 0) {
          return {
            ok: true,
            content: `No items to review right now for topic "${args.topic}" in mode "${mode}". Great job!`,
          }
        }

        const itemsOutput = selected.map((item, idx) => {
          const isQuiz = 'options' in item
          const typeLabel = isQuiz ? 'Quiz Question' : 'Flashcard'
          const optionsText = isQuiz && item.options && item.options.length > 0 ? `\nOptions:\n${item.options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}` : ''
          const hintText = 'hint' in item && item.hint ? `\nHint: ${item.hint}` : ''
          return `### Item ${idx + 1}: [${item.id}] (${typeLabel})\n**Question:** ${item.question}${optionsText}${hintText}\n*(Attempts: ${item.attempts}, Correct: ${item.correctCount}, Status: ${item.lastResult || 'untested'})\n*`
        })

        return {
          ok: true,
          content:
            `Review Session for "${deck.metadata.title}" (Mode: ${mode}, showing ${selected.length} of ${pool.length}):\n\n` +
            itemsOutput.join('\n\n') +
            `\n\nTo submit answers, call tutor_quiz with topic "${args.topic}" and answers: [{ id, result: "correct" | "missed" } or { id, answer: "..." }]`,
        }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

export function tutorProgressTool(getWorkspaceRoot: () => string): ToolDefinition<{ topic?: string }> {
  return {
    name: TUTOR_PROGRESS_NAME,
    description: 'Inspect mastery stats, review history, accuracy, and missed cards for study decks.',
    schema: TUTOR_PROGRESS_SCHEMA,
    permissionLevel: 'safe',
    async execute(args): Promise<ToolResult> {
      try {
        const root = getWorkspaceRoot()
        if (args.topic) {
          const deck = await loadDeck(root, args.topic)
          if (!deck) {
            return { ok: false, content: '', error: `Deck for topic "${args.topic}" not found.` }
          }
          const progress = computeProgress(deck)
          const missedItems = [...deck.flashcards, ...deck.quizQuestions].filter((i) => i.lastResult === 'missed')

          return {
            ok: true,
            content:
              `# Progress for "${progress.title}" (${progress.topic})\n` +
              `- Total Items: ${progress.totalCards} flashcards, ${progress.totalQuizzes} quiz questions\n` +
              `- Reviewed: ${progress.reviewedCards} items\n` +
              `- Mastered: ${progress.masteredCards} items\n` +
              `- Missed / Weak: ${progress.missedCards} items\n` +
              `- Accuracy Rate: ${progress.accuracyRate}%\n` +
              `- Last Reviewed: ${progress.lastReviewedAt || 'Never'}\n\n` +
              (missedItems.length > 0 ? `### Missed Items Queue:\n` + missedItems.map((m) => `- [${m.id}] ${m.question} (Correct: ${m.answer})`).join('\n') : 'No missed items!'),
          }
        }

        const decks = await listDecks(root)
        if (decks.length === 0) {
          return { ok: true, content: 'No study decks found in the workspace. Use tutor_save to create one.' }
        }

        const summaries = await Promise.all(
          decks.map(async (d) => {
            const deck = await loadDeck(root, d.topic)
            return deck ? computeProgress(deck) : null
          }),
        )

        const validSummaries = summaries.filter(Boolean) as TutorProgressSummary[]

        return {
          ok: true,
          content:
            `# Tutor Workspace Progress (${validSummaries.length} decks):\n\n` +
            validSummaries
              .map(
                (s) =>
                  `- **${s.title}** (\`${s.topic}\`):\n` +
                  `  - Mastery: ${s.masteredCards}/${s.totalCards + s.totalQuizzes} items\n` +
                  `  - Accuracy: ${s.accuracyRate}%\n` +
                  `  - Missed: ${s.missedCards} items`,
              )
              .join('\n\n'),
        }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

export function tutorListTool(getWorkspaceRoot: () => string): ToolDefinition<{}> {
  return {
    name: TUTOR_LIST_NAME,
    description: 'List all available tutor study decks and summaries in the workspace.',
    schema: TUTOR_LIST_SCHEMA,
    permissionLevel: 'safe',
    async execute(_args, context: ToolExecutionContext): Promise<ToolResult> {
      try {
        const root = getWorkspaceRoot()
        const decks = await listDecks(root)
        if (decks.length === 0) {
          return { ok: true, content: 'No tutor study decks found in .openagent/tutor/.' }
        }

        return {
          ok: true,
          content:
            `Found ${decks.length} tutor study decks in .openagent/tutor/:\n\n` +
            decks
              .map(
                (d) =>
                  `- **${d.title}** (\`${d.topic}\`)\n` +
                  (d.description ? `  - Description: ${d.description}\n` : '') +
                  `  - Updated: ${d.updatedAt}`,
              )
              .join('\n\n'),
        }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

export function mountTutorTools(
  tools: { register: (tool: ToolDefinition<any>) => void },
  getWorkspaceRoot: () => string,
): () => void {
  const save = tutorSaveTool(getWorkspaceRoot)
  const quiz = tutorQuizTool(getWorkspaceRoot)
  const progress = tutorProgressTool(getWorkspaceRoot)
  const list = tutorListTool(getWorkspaceRoot)

  tools.register(save)
  tools.register(quiz)
  tools.register(progress)
  tools.register(list)

  return () => {
    // Unregistration not required as registry replaces/clears
  }
}
