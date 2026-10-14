import type { ProxyResponse } from "@/types/proxy-fetch"
import { logger } from "@/utils/logger"
import { onMessage } from "@/utils/message"

function encodeArrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

export function proxyFetch() {
  // Proxy cross-origin fetches for content scripts and other contexts
  onMessage("backgroundFetch", async (message): Promise<ProxyResponse> => {
    logger.info("[ProxyFetch] Background fetch:", message.data)

    const {
      url,
      method,
      headers,
      body,
      credentials,
      redirect,
      responseType = "text",
    } = message.data

    const finalMethod = (method ?? "GET").toUpperCase()

    const response = await fetch(url, {
      method: finalMethod,
      headers: headers ? new Headers(headers) : undefined,
      body,
      credentials: credentials ?? "include",
      redirect,
    })

    const responseHeaders: [string, string][] = [...response.headers.entries()]
    const responseBody = responseType === "base64"
      ? encodeArrayBufferToBase64(await response.arrayBuffer())
      : await response.text()

    const result = {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      bodyEncoding: responseType,
    }

    logger.info("[ProxyFetch] Response:", result)

    return result
  })
}
