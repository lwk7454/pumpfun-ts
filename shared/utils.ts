export function wait(seconds: number) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

export function waitApprox(seconds: number, variance: number = 0.1) {
  const random = Math.random() * seconds * variance * 2 - variance
  return wait(seconds + random)
}

export async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3, backoffFactor = 2): Promise<Response> {
  let attempt = 0
  let delay = 1000 // 1 second base
  let lastError: unknown = null

  while (attempt < maxRetries) {
    try {
      const response = await fetch(url, options)
      if (!response.ok) {
        console.error({ response: await response.json() })
        throw new Error(`HTTP ${response.status} - ${response.statusText}`)
      }
      return response
    } catch (err) {
      attempt++
      lastError = err
      console.warn(`fetchWithRetry error on attempt ${attempt}: ${err}. Retrying in ${delay} ms...`)
      await wait(delay)
      delay *= backoffFactor
    }
  }
  throw new Error(`fetchWithRetry failed after ${maxRetries} attempts. Last error: ${lastError}`)
}
