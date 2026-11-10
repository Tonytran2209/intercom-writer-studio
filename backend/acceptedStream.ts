import type { Request, Response } from "express"

// ui-kpi-v2 acknowledgement. A client that sends `X-Accept-Ack: 1` receives NDJSON:
// first {"event":"accepted"} as soon as the route has validated the request and is about to
// start the AI work, then exactly one {"event":"result","status":<http status>,"body":<json>}
// carrying what the route would otherwise have sent with res.status(status).json(body).
// Requests without the header keep the plain JSON response unchanged.
export const ACK_HEADER = "x-accept-ack"
export const ACK_CONTENT_TYPE = "application/x-ndjson; charset=utf-8"

export function acceptOnRequest(req: Request, res: Response): () => void {
  if (req.get(ACK_HEADER) !== "1") return () => {}
  let accepted = false
  return () => {
    if (accepted || res.headersSent || res.writableEnded) return
    accepted = true
    res.status(200)
    res.setHeader("Content-Type", ACK_CONTENT_TYPE)
    res.setHeader("Cache-Control", "no-cache, no-transform")
    res.setHeader("X-Accel-Buffering", "no")
    res.flushHeaders()
    res.write(JSON.stringify({ event: "accepted" }) + "\n")
    let status = 200
    res.status = ((code: number) => {
      status = code
      return res
    }) as Response["status"]
    res.json = ((body: unknown) => {
      // HTTP monitoring keeps counting the logical status, not the 200 stream status.
      res.locals.reportedStatus = status
      res.end(JSON.stringify({ event: "result", status, body: body ?? null }) + "\n")
      return res
    }) as Response["json"]
  }
}
