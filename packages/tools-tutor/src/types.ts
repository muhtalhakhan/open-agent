/**
 * Types and schema for Tutor tools (@open-agent/tools-tutor).
 */

export interface Flashcard {
  id: string
  question: string
  answer: string
  hint?: string
  tags?: readonly string[]
  // Learning / Spaced-repetition metrics
  attempts: number
  correctCount: number
  lastReviewedAt?: string
  lastResult?: 'correct' | 'missed'
}

export interface QuizQuestion {
  id: string
  question: string
  options?: readonly string[]
  answer: string
  explanation?: string
  // Learning metrics
  attempts: number
  correctCount: number
  lastReviewedAt?: string
  lastResult?: 'correct' | 'missed'
}

export interface DeckMetadata {
  topic: string
  title: string
  description?: string
  sourceFile?: string
  createdAt: string
  updatedAt: string
}

export interface SavedDeckFile {
  version: 1
  metadata: DeckMetadata
  flashcards: Flashcard[]
  quizQuestions: QuizQuestion[]
}

export interface TutorProgressSummary {
  topic: string
  title: string
  totalCards: number
  totalQuizzes: number
  reviewedCards: number
  masteredCards: number // e.g., correctCount >= 2 and lastResult === 'correct'
  missedCards: number // lastResult === 'missed'
  accuracyRate: number
  lastReviewedAt?: string
}
