import type { Request, Response, NextFunction } from "express"
import cors from "cors"
import { config } from "../config.js"

export function setupMiddleware(router: { use: (fn: any) => void }): void {
  // Global request logger — MUST be before cors() so we see every request,
  // including preflight OPTIONS that cors rejects.
  router.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now()
    const method = req.method
    const path = req.path
    const contentType = req.get("content-type") ?? ""
    const contentLength = req.get("content-length") ?? ""

    console.log(`[request] --> ${method} ${path} content-type=${contentType} content-length=${contentLength}`)

    res.on("finish", () => {
      const duration = Date.now() - start
      console.log(`[request] <-- ${method} ${path} ${res.statusCode} ${duration}ms`)
    })

    next()
  })

  router.use(cors({
    origin: config.corsOrigins,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  }))
}