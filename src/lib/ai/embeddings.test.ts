import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { embedTexts, cosineSimilarity, parseEmbedding, serializeEmbedding } from './embeddings'

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('embedTexts', () => {
  it('returns [] for an empty input', async () => {
    expect(await embedTexts('sk-test', [])).toEqual([])
  })

  it('embeds a batch preserving input order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          data: [
            { embedding: [0.1, 0.2], index: 0 },
            { embedding: [0.3, 0.4], index: 1 },
          ],
        }),
      ),
    )
    const out = await embedTexts('sk-test', ['a', 'b'])
    expect(out).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
  })

  it('sorts results by index even when the provider shuffles them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          data: [
            { embedding: [1, 1], index: 1 },
            { embedding: [0, 0], index: 0 },
          ],
        }),
      ),
    )
    const out = await embedTexts('sk-test', ['a', 'b'])
    expect(out).toEqual([
      [0, 0],
      [1, 1],
    ])
  })

  it('throws on a malformed response (missing indices)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ data: [{ embedding: [0.1, 0.2] }] }),
      ),
    )
    await expect(embedTexts('sk-test', ['a'])).rejects.toMatchObject({
      code: 'embeddings_malformed',
    })
  })
})

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('returns 0 for empty / zero vectors', () => {
    expect(cosineSimilarity([], [1])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })

  it('ranks a closer vector higher', () => {
    const query = [1, 0]
    const close = cosineSimilarity(query, [0.9, 0.1])
    const far = cosineSimilarity(query, [0.1, 0.9])
    expect(close).toBeGreaterThan(far)
  })
})

describe('serialize / parse embedding', () => {
  it('round-trips a vector', () => {
    const v = [0.1, 0.2, -0.3]
    expect(parseEmbedding(serializeEmbedding(v))).toEqual(v)
  })

  it('returns null for malformed input', () => {
    expect(parseEmbedding('not json')).toBeNull()
    expect(parseEmbedding('[1,"x"]')).toBeNull()
    expect(parseEmbedding(42)).toBeNull()
    expect(parseEmbedding(null)).toBeNull()
  })
})
