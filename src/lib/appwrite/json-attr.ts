/**
 * Appwrite 1.x stores JSON configs (trigger_config, step_config, node
 * config) as JSON *strings* — the API rejects plain objects on string
 * attributes. These helpers keep the round-trip invisible: stringify
 * before writing, parse after reading.
 */

export function stringifyConfig(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

export function parseConfig<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') {
    return (value ?? fallback) as T
  }
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
