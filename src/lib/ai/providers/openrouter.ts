import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

// OpenRouter exposes an OpenAI-compatible Chat Completions API, so this
// adapter is intentionally thin: same wire format as generateOpenAi,
// with OpenRouter's routing headers. Override the endpoint with
// AI_OPENROUTER_BASE_URL to point at a compatible proxy.
const OPENROUTER_URL =
  process.env.AI_OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1/chat/completions'

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Call OpenRouter's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenRouter(
  args: ProviderArgs,
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter's attribution headers — optional but encouraged so
        // the app shows up in their traffic dashboard.
        'HTTP-Referer': 'https://wacrm.app',
        'X-Title': 'WACRM',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenRouter', res)
  }

  const data = (await res.json().catch(() => null)) as OpenRouterResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenRouter returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}
