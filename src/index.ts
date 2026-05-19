import express from "express"
import { config } from "./config.js"
import { exportRouter } from "./api/routes.js"
import { setupMiddleware } from "./api/middleware.js"
import { ensureTempDir, cleanupOldFiles } from "./storage/assetStore.js"
import { detectGpuCapabilities } from "./engine/gpuDetector.js"

const app = express()
const PORT = config.port

// Global error handlers — prevent silent crashes
process.on("unhandledRejection", (reason) => {
  console.error("[AloMediaServer] Unhandled rejection:", reason)
})

process.on("uncaughtException", (err) => {
  console.error("[AloMediaServer] Uncaught exception:", err)
})

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

  const server = app.listen(PORT, () => {
    console.log(`[AloMediaServer] Export server running on port ${PORT}`)
    console.log(`[AloMediaServer] GPU acceleration: ${gpu.nvenc ? "NVENC" : gpu.qsv ? "QuickSync" : "CPU only"}`)
    console.log(`[AloMediaServer] Selected encoder: ${gpu.selectedEncoder}`)
    console.log(`[AloMediaServer] Max concurrent jobs: ${config.maxConcurrentJobs}`)
    console.log(`[AloMediaServer] Temp directory: ${config.tempDir}`)
    console.log(`[AloMediaServer] CORS origins: ${config.corsOrigins.join(", ")}`)
  })

  // prevent long-running connections from hanging forever
  server.timeout = 300000 // 5 minutes
  server.keepAliveTimeout = 65000
  server.headersTimeout = 66000
}

start().catch((err) => {
  console.error("[AloMediaServer] Failed to start:", err)
  process.exit(1)
})