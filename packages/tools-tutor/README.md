# @open-agent/tools-tutor

Study help tools: `tutor_save`, `tutor_quiz`, `tutor_progress`, and `tutor_list` (issue #284).

## What are tutor tools?

These tools turn material (text, workspace files, documentation) into structured study decks and run interactive spaced repetition quizzes:

- **`tutor_save`**: Save study material including a summary, flashcards, and quiz questions for a topic.
- **`tutor_quiz`**: Run an interactive quiz/review session, track correct/missed cards, and update spaced repetition stats.
- **`tutor_progress`**: Inspect mastery stats, review history, and missed cards queue for a topic or all topics.
- **`tutor_list`**: List all available tutor study decks and summaries in the workspace.

## Storage Format

Saved in `.openagent/tutor/` in the workspace:

- `<topic>-summary.md`: Clean Markdown summary of the topic.
- `<topic>-deck.json`: Flashcards, quiz questions, and study/missed stats.
