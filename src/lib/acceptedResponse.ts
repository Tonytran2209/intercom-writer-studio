// Client side of the ui-kpi-v2 acknowledgement (backend/acceptedStream.ts). The request opts in
// with X-Accept-Ack: 1; the server streams {"event":"accepted"} before its AI work and then one
// {"event":"result","status","body"}. The result is returned as an ordinary Response so callers
// keep their existing ok/error handling. A plain JSON answer (no opt-in support) is returned as is.
export const ACK_HEADER = "X-Accept-Ack"

export async function readAcceptedResponse(response: Response, onAccepted: () => void): Promise<Response> {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson") || !response.body) return response
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let accepted = false
  const accept = () => {
    if (accepted) return
    accepted = true
    onAccepted()
  }
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    const lines = buffer.split("\n")
    buffer = done ? "" : lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as { event?: string; status?: number; body?: unknown }
      if (event.event === "accepted") accept()
      else if (event.event === "result") {
        accept()
        void reader.cancel().catch(() => {})
        const status = Number.isInteger(event.status) && event.status! >= 200 && event.status! <= 599 ? event.status! : 500
        return new Response([204, 205, 304].includes(status) ? null : JSON.stringify(event.body ?? null), { status, headers: { "Content-Type": "application/json" } })
      }
    }
    if (done) break
  }
  throw new Error("The server closed the connection before returning a result.")
}

export async function acceptedFetch(url: string, init: RequestInit, onAccepted: () => void): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set(ACK_HEADER, "1")
  return readAcceptedResponse(await fetch(url, { ...init, headers }), onAccepted)
}
