/** Most items, checks or levels one call takes: one question each, and the model answers them together. */
export const MAX_ITEMS = 64
export const MAX_CANDIDATES = 250
export const MAX_LEVELS = 20
/** Long enough to judge by; the rest of a log or a file rarely changes the answer and always costs. */
export const ITEM_CHARS = 4_000

export interface Item {
  /** The caller's id, echoed back exactly. */
  id: string
  /** The key questions refer to it by: safe inside a backticked path such as `items.<key>`. */
  key: string
  text: string
  truncated: boolean
}

export class ArgumentError extends Error {}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ArgumentError(`${name} must be a non-empty string`)
  return value.trim()
}

/**
 * Validates `[{ id, text }]` from the model and gives each a key the
 * questions can name. Ids are the caller's to map results back by, so two
 * that would collapse to the same key are refused rather than renamed.
 */
export function prepareItems(value: unknown, name: string, max: number): Item[] {
  if (!Array.isArray(value) || value.length === 0) throw new ArgumentError(`${name} must be a non-empty array`)
  if (value.length > max) throw new ArgumentError(`${name} has ${value.length} entries; send at most ${max} per call`)
  const keys = new Map<string, string>()
  return value.map((entry, index) => {
    const { id, text } = (entry ?? {}) as { id?: unknown; text?: unknown }
    if (typeof text !== 'string') throw new ArgumentError(`${name}[${index}].text must be a string`)
    const label = typeof id === 'string' || typeof id === 'number' ? String(id) : String(index + 1)
    const key = label.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64) || `item_${index + 1}`
    const clash = keys.get(key)
    if (clash !== undefined) throw new ArgumentError(`${name} ids "${clash}" and "${label}" are not distinct`)
    keys.set(key, label)
    const truncated = text.length > ITEM_CHARS
    return { id: label, key, text: truncated ? `${text.slice(0, ITEM_CHARS)} […truncated]` : text, truncated }
  })
}

export function itemsByKey(items: Item[]): Record<string, string> {
  return Object.fromEntries(items.map((item) => [item.key, item.text]))
}

export const round = (value: number) => Math.round(value * 1000) / 1000
