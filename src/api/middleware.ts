import type { Request, Response, NextFunction } from "express"
import cors from "cors"
import { config } from "../config.js"

export function setupMiddleware(router: { use: (fn: any) => void }): void {
  router.use(cors({
    origin: config.corsOrigins,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  }))

  router.use((req: Request, _res: Response, next: NextFunction) => {
    const start = Date.now()
    _res.on("finish", () => {
      const duration = Date.now() - start
      console.log(`${req.method} ${req.path} ${_res.statusCode} ${duration}ms`)
    })
    next()
  })
}