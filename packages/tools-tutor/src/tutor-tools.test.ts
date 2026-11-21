import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveDeck,
  loadDeck,
  loadSummary,
  listDecks,
  tutorSaveTool,
  tutorQuizTool,
  tutorProgressTool,
  tutorListTool,
  mountTutorTools,
} from './index.js'

describe('tools-tutor', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tutor-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('saves and loads a study deck and summary', async () => {
    const res = await saveDeck(tempDir, 'typescript-basics', {
      title: 'TypeScript Basics',
      summary: 'TypeScript is a typed superset of JavaScript.',
      description: 'Core concepts of TS',
      flashcards: [
        { id: 'c1', question: 'What is any?', answer: 'A type that disables type checking.' },
        { id: 'c2', question: 'What is unknown?', answer: 'A type-safe counterpart of any.' },
      ],
      quizQuestions: [
        {
          id: 'q1',
          question: 'Which operator is used for non-null assertion?',
          options: ['?', '!', '??', '||'],
          answer: '!',
          explanation: '! tells the compiler that the value cannot be null or undefined.',
        },
      ],
    })

    expect(res.topic).toBe('typescript-basics')

    const deck = await loadDeck(tempDir, 'typescript-basics')
    expect(deck).not.toBeNull()
    expect(deck?.metadata.title).toBe('TypeScript Basics')
    expect(deck?.flashcards).toHaveLength(2)
    expect(deck?.quizQuestions).toHaveLength(1)

    const summary = await loadSummary(tempDir, 'typescript-basics')
    expect(summary).toContain('TypeScript is a typed superset of JavaScript.')
  })

  it('runs tutorSaveTool successfully', async () => {
    const tool = tutorSaveTool(() => tempDir)
    const result = await tool.execute({
      topic: 'react-hooks',
      title: 'React Hooks Overview',
      summary: 'Hooks allow function components to use state.',
      flashcards: [{ question: 'What does useState do?', answer: 'Declares state variable' }],
      quizQuestions: [{ question: 'Can hooks be conditional?', answer: 'No' }],
    })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('Successfully saved study deck')

    const decks = await listDecks(tempDir)
    expect(decks).toHaveLength(1)
    expect(decks[0].topic).toBe('react-hooks')
  })

  it('serves items and grades answers in tutorQuizTool', async () => {
    // 1. Create a deck
    await saveDeck(tempDir, 'git-flow', {
      title: 'Git Flow',
      summary: 'Git branching strategy.',
      flashcards: [{ id: 'card-1', question: 'What is git rebase?', answer: 'Reapplies commits on another base' }],
      quizQuestions: [{ id: 'quiz-1', question: 'What does git merge do?', answer: 'Joins branches' }],
    })

    const quizTool = tutorQuizTool(() => tempDir)

    // 2. Fetch quiz questions to review
    const sessionRes = await quizTool.execute({
      topic: 'git-flow',
      mode: 'quiz',
    })
    expect(sessionRes.ok).toBe(true)
    expect(sessionRes.content).toContain('What does git merge do?')

    // 3. Submit correct answer
    const gradeRes = await quizTool.execute({
      topic: 'git-flow',
      answers: [{ id: 'quiz-1', answer: 'Joins branches' }],
    })
    expect(gradeRes.ok).toBe(true)
    expect(gradeRes.content).toContain('[CORRECT] quiz-1')

    // 4. Submit missed answer on flashcard
    const missedRes = await quizTool.execute({
      topic: 'git-flow',
      answers: [{ id: 'card-1', result: 'missed' }],
    })
    expect(missedRes.ok).toBe(true)
    expect(missedRes.content).toContain('[MISSED] card-1')

    // 5. Check progress tool
    const progressTool = tutorProgressTool(() => tempDir)
    const progRes = await progressTool.execute({ topic: 'git-flow' })
    expect(progRes.ok).toBe(true)
    expect(progRes.content).toContain('Missed / Weak: 1 items')
    expect(progRes.content).toContain('Missed Items Queue:')
    expect(progRes.content).toContain('card-1')
  })

  it('lists decks with tutorListTool', async () => {
    const listTool = tutorListTool(() => tempDir)

    // Initially empty
    const emptyRes = await listTool.execute({}, {} as any)
    expect(emptyRes.ok).toBe(true)
    expect(emptyRes.content).toContain('No tutor study decks found')

    // Add deck
    await saveDeck(tempDir, 'algorithms', {
      title: 'Algorithms',
      summary: 'Data structures & algorithms.',
      flashcards: [],
      quizQuestions: [],
    })

    const populatedRes = await listTool.execute({}, {} as any)
    expect(populatedRes.ok).toBe(true)
    expect(populatedRes.content).toContain('Algorithms')
    expect(populatedRes.content).toContain('algorithms')
  })

  it('mounts all tools with mountTutorTools', () => {
    const registered: string[] = []
    const mockRegistry = {
      register: (tool: { name: string }) => {
        registered.push(tool.name)
      },
    }

    mountTutorTools(mockRegistry, () => tempDir)
    expect(registered).toEqual(['tutor_save', 'tutor_quiz', 'tutor_progress', 'tutor_list'])
  })
})
