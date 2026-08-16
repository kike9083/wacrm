/**
 * Maps an Appwrite document (keyed by `$id`) to a domain row keyed by
 * `id`. The domain types (`Automation`, `FlowRow`, ...) all use `id`,
 * so every boundary where documents are cast to domain types must go
 * through this helper — otherwise `.id` is `undefined` and queries
 * like `Query.equal('automation_id', undefined)` explode with
 * "Equal queries require at least one value".
 */
export function mapDocId<T>(doc: Record<string, unknown>): T {
  return { ...(doc as object), id: doc.$id } as T
}