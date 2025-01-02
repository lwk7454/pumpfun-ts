import { Logger } from "@logger"

export function wait(seconds: number) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

export function waitApprox(seconds: number, variance: number = 0.1) {
  const random = Math.random() * seconds * variance * 2 - variance
  return wait(seconds + random)
}

export function shorten(address: string) {
  return address.slice(0, 6)
}

export function printSol(amount: number) {
  return amount.toFixed(7)
}

let isDryRunVar: boolean | undefined = undefined

export const isDryRun = () => {
  if (isDryRunVar === undefined) {
    isDryRunVar = Deno.env.get("DRY_RUN") === "true"
  }
  return isDryRunVar
}

export async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3, backoffFactor = 2): Promise<Response> {
  let attempt = 0
  let delay = 1000 // 1 second base
  let lastError: unknown = null

  while (attempt < maxRetries) {
    try {
      const response = await fetch(url, options)
      if (!response.ok) {
        logger.error({ response: await response.json() })
        throw new Error(`HTTP ${response.status} - ${response.statusText}`)
      }
      return response
    } catch (err) {
      attempt++
      lastError = err
      logger.warn(`fetchWithRetry error on attempt ${attempt}: ${err}. Retrying in ${delay} ms...`)
      await wait(delay)
      delay *= backoffFactor
    }
  }
  throw new Error(`fetchWithRetry failed after ${maxRetries} attempts. Last error: ${lastError}`)
}

export async function fetchWithScraper(url: string, options: RequestInit): Promise<string> {
  const proxyUrl = "https://realtime.oxylabs.io/v1/queries"
  const auth = Deno.env.get("OXYLABS_AUTH")
  if (!auth) {
    throw new Error("OXYLABS_AUTH is not set")
  }
  const data = {
    source: "universal",
    url
  }

  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${btoa(auth)}`,
      ...options.headers
    },
    body: JSON.stringify(data)
  })

  if (response.ok) {
    const result = await response.json()
    return result['results'][0]['content']
  } else {
    throw new Error(`Proxy error: ${response.status} ${response.statusText}`)
  }
}

export async function fetchWithProxy(url: string, options: RequestInit = {}): Promise<string> {
  const proxyHost = 'https://brd.superproxy.io:33335'
  const username = Deno.env.get("SUPER_PROXY_USER") ?? ''
  const password = Deno.env.get("SUPER_PROXY_PASSWORD") ?? ''

  if (!username || !password) {
    throw new Error("Proxy credentials are not set (SUPER_PROXY_USER / SUPER_PROXY_PASSWORD).")
  }

  const client = Deno.createHttpClient({
    proxy: {
      url: proxyHost,
      basicAuth: { username, password },
    },
  })

  const response = await fetch(url, {
    ...options,
    client,
  })

  if (!response.ok) {
    throw new Error(`Proxy error: ${response.status} ${response.statusText}`)
  }

  return await response.text()
}

export const logger = new Logger()
