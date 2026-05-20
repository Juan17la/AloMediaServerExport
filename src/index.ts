import express from "express"
import { config } from "./config.js"
import { exportRouter, shutdownExports, queue } from "./api/routes.js"
import { setupMiddleware } from "./api/middleware.js"
import { ensureTempDir, cleanupOldFiles } from "./storage/assetStore.js"
import { detectGpuCapabilities } from "./engine/gpuDetector.js"
import type { Server } from "node:http"

const app = express()
const PORT = config.port

let server: Server | null = null

async function start() {
  await ensureTempDir()

  const gpu = await detectGpuCapabilities()

  app.use(express.json({ limit: "100mb" }))
  setupMiddleware(app)

  app.use("/api", exportRouter)

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      gpuAccel: gpu.nvenc || gpu.qsv,
      gpuCodec: gpu.selectedCodec !== "libx264" ? gpu.selectedCodec : null,
      maxConcurrentJobs: config.maxConcurrentJobs,
      version: "1.0.0",
    })
  })

  setInterval(() => {
    cleanupOldFiles().catch(() => {})
  }, 60000)

  server = app.listen(PORT, () => {
    console.log(`[AloMediaServer] Export server running on port ${PORT}`)
    console.log(`[AloMediaServer] GPU acceleration: ${gpu.nvenc ? "NVENC" : gpu.qsv ? "QuickSync" : "CPU only"}`)
    console.log(`[AloMediaServer] Selected encoder: ${gpu.selectedEncoder}`)
    console.log(`[AloMediaServer] Max concurrent jobs: ${config.maxConcurrentJobs}`)
    console.log(`[AloMediaServer] Temp directory: ${config.tempDir}`)
  })
}

function gracefulShutdown(signal: string) {
  console.log(`[AloMediaServer] Received ${signal}. Starting graceful shutdown...`)

  if (server) {
    server.close(() => {
      console.log("[AloMediaServer] HTTP server closed")
    })
  }

  shutdownExports()

  // Force exit after 25 seconds (Railway hobby gives ~30s before SIGKILL)
  const forceExit = setTimeout(() => {
    console.error("[AloMediaServer] Force exiting after grace period")
    process.exit(1)
  }, 25000)

  // Poll until active jobs finish or we time out
  const interval = setInterval(() => {
    if (queue.getActiveCount() === 0) {
      clearInterval(interval)
      clearTimeout(forceExit)
      console.log("[AloMediaServer] All jobs cleared. Exiting.")
      process.exit(0)
    }
  }, 500)
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
process.on("SIGINT", () => gracefulShutdown("SIGINT"))

process.on("uncaughtException", (err) => {
  console.error("[AloMediaServer] Uncaught exception:", err)
  gracefulShutdown("uncaughtException")
})

process.on("unhandledRejection", (reason) => {
  console.error("[AloMediaServer] Unhandled rejection:", reason)
})

start().catch((err) => {
  console.error("[AloMediaServer] Failed to start:", err)
  process.exit(1)
})
