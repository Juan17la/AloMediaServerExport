import { Router, type Request, type Response, type NextFunction } from "express"
import multer from "multer"
import { config } from "../config.js"
import { JobQueue, createJobId } from "../queue/jobQueue.js"
import type { ExportJob, RenderPlan } from "../types.js"
import { executePipeline } from "../engine/pipeline.js"
import { cleanupJobFiles } from "../storage/assetStore.js"
import { stat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, join(config.tempDir, "uploads"))
    },
    filename: (_req, file, cb) => {
      const mediaId = file.fieldname.replace("file_", "")
      const ext = file.originalname.split(".").pop() ?? "mp4"
      const uid = randomUUID().slice(0, 8)
      cb(null, `${mediaId}_${uid}.${ext}`)
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
})

const queue = new JobQueue(config.maxConcurrentJobs)
const jobs = new Map<string, ExportJob>()

export const exportRouter = Router()

exportRouter.get("/test-ffmpeg", async (_req: Request, res: Response) => {
  console.log("[test-ffmpeg] Running FFmpeg diagnostic...")
  const start = Date.now()

  const child = spawn(config.ffmpegPath, [
    "-f", "lavfi",
    "-i", "testsrc=duration=1:size=320x240:rate=1",
    "-pix_fmt", "yuv420p",
    "-f", "null",
    "-",
  ])

  let stderr = ""
  let timedOut = false

  const timeout = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 30000)

  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString()
  })

  child.on("close", (code, signal) => {
    clearTimeout(timeout)
    const duration = Date.now() - start
    console.log(`[test-ffmpeg] Finished in ${duration}ms — exitCode=${code}, signal=${signal}, timedOut=${timedOut}`)
    res.json({
      ok: code === 0 && !timedOut,
      exitCode: code,
      signal,
      timedOut,
      durationMs: duration,
      stderrPreview: stderr.slice(-2000),
    })
  })

  child.on("error", (err) => {
    clearTimeout(timeout)
    console.error("[test-ffmpeg] Spawn error:", err.message)
    res.status(500).json({ ok: false, error: err.message })
  })
})

exportRouter.post("/test-upload", upload.any(), (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[] | undefined
  const body = req.body
  const fileCount = Array.isArray(files) ? files.length : 0
  const totalSize = Array.isArray(files) ? files.reduce((sum, f) => sum + f.size, 0) : 0
  const paths = Array.isArray(files) ? files.map((f) => ({ field: f.fieldname, path: f.path, size: f.size })) : []
  console.log(`[test-upload] Received upload — files=${fileCount}, totalSize=${totalSize}`)
  res.json({
    ok: true,
    fileCount,
    totalSize,
    bodyKeys: Object.keys(body || {}),
    files: paths,
  })
})

// Multer error handler — must be after the upload middleware if used inline,
// but we handle errors in the catch block of the route.
function multerErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof multer.MulterError) {
    console.error("[multer] Error:", err.message, err.code)
    res.status(400).json({ error: "Upload error", detail: err.message, code: err.code })
    return
  }
  if (err instanceof Error) {
    console.error("[upload] Error:", err.message)
    res.status(500).json({ error: err.message })
    return
  }
  res.status(500).json({ error: "Unknown upload error" })
}

exportRouter.post(
  "/export",
  (req: Request, _res: Response, next: NextFunction) => {
    console.log(`[export] Incoming POST — content-type=${req.get("content-type") ?? "unknown"}, content-length=${req.get("content-length") ?? "unknown"}`)
    next()
  },
  upload.any(),
  async (req: Request, res: Response) => {
    try {
      console.log("[export] Handler entered — parsing plan...")
      const planJson = req.body.plan
      if (!planJson) {
        const bodyKeys = req.body ? Object.keys(req.body) : []
        const filesCount = Array.isArray(req.files) ? req.files.length : req.files ? 1 : 0
        console.warn("[export] Called without plan", { bodyKeys, filesCount, contentType: req.get("content-type") })
        res.status(400).json({ error: "Missing plan", bodyKeys, filesCount, contentType: req.get("content-type") })
        return
      }

      const plan: RenderPlan = typeof planJson === "string" ? JSON.parse(planJson) : planJson

      const jobId = createJobId()
      const files = req.files as Express.Multer.File[]
      console.log(`[export] jobId=${jobId} — files=${files.length}`)

      // Build asset map from disk-storage paths (files already on disk)
      const assetPaths = new Map<string, string>()
      for (const file of files) {
        const mediaId = file.fieldname.replace("file_", "")
        assetPaths.set(mediaId, file.path)
        console.log(`[export] Asset mapped — mediaId=${mediaId}, path=${file.path}, size=${file.size}`)
      }

      const job: ExportJob = {
        id: jobId,
        plan,
        status: "pending",
        progress: 0,
        framesProcessed: 0,
        framesTotal: plan.estimatedTotalFrames,
        startedAt: null,
        completedAt: null,
        error: null,
        outputFilePath: null,
        engine: "native",
        createdAt: Date.now(),
      }

      jobs.set(jobId, job)

      console.log(`[export] Responding with jobId=${jobId}, queueLength=${queue.getQueueLength()}, active=${queue.getActiveCount()}`)

      // Process asynchronously — respond immediately, work in background
      processJob(jobId, plan, assetPaths).catch((err) => {
        const storedJob = jobs.get(jobId)
        if (storedJob) {
          storedJob.status = "failed"
          storedJob.error = err instanceof Error ? err.message : "Unknown error"
          storedJob.completedAt = Date.now()
        }
      })

      res.json({ jobId })
    } catch (err) {
      console.error("[export] Unhandled error:", err)
      res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" })
    }
  },
  multerErrorHandler,
)

exportRouter.get("/export/:id/status", async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  if (!id) {
    res.status(400).json({ error: "Missing id" })
    return
  }
  const job = jobs.get(id)
  if (!job) {
    res.status(404).json({ error: "Job not found" })
    return
  }

  res.json({
    status: job.status,
    progress: job.progress,
    framesProcessed: job.framesProcessed,
    framesTotal: job.framesTotal,
    error: job.error,
  })
})

exportRouter.get("/export/:id/download", async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  if (!id) {
    res.status(400).json({ error: "Missing id" })
    return
  }
  const job = jobs.get(id)
  if (!job) {
    res.status(404).json({ error: "Job not found" })
    return
  }

  if (job.status !== "done" || !job.outputFilePath) {
    res.status(400).json({ error: "Job not completed" })
    return
  }

  try {
    const fileStats = await stat(job.outputFilePath)
    res.setHeader("Content-Length", fileStats.size)
    res.setHeader("Content-Type", getMimeType(job.plan?.outputTarget.format ?? "mp4"))
    res.setHeader("Content-Disposition", `attachment; filename="export_${job.id}.${job.plan?.outputTarget.format ?? "mp4"}"`)

    const fileBuffer = await readFile(job.outputFilePath)
    res.send(fileBuffer)
  } catch {
    res.status(500).json({ error: "Failed to read output file" })
  }
})

exportRouter.delete("/export/:id", async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  if (!id) {
    res.status(400).json({ error: "Missing id" })
    return
  }
  const job = jobs.get(id)
  if (!job) {
    res.status(404).json({ error: "Job not found" })
    return
  }

  if (job.status === "encoding" || job.status === "pending") {
    job.status = "cancelled"
    job.completedAt = Date.now()
    queue.removeJob(job.id)
  }

  await cleanupJobFiles(job.id)
  jobs.delete(id)
  res.json({ cancelled: true })
})

async function processJob(jobId: string, plan: RenderPlan, assetPaths: Map<string, string>): Promise<void> {
  console.log(`[processJob] Starting jobId=${jobId}`)
  const job = jobs.get(jobId)
  if (!job) {
    console.warn(`[processJob] Job ${jobId} not found in jobs map`)
    return
  }

  job.status = "probing"
  job.startedAt = Date.now()
  queue.markActive(jobId)
  console.log(`[processJob] Assets: ${[...assetPaths.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`)

  job.status = "encoding"
  console.log(`[processJob] Executing pipeline for jobId=${jobId}`)

  const abortController = new AbortController()

  try {
    const result = await executePipeline(
      job,
      plan,
      assetPaths,
      (status, progress, framesProcessed, framesTotal) => {
        job.status = status as ExportJob["status"]
        job.progress = progress
        job.framesProcessed = framesProcessed
        job.framesTotal = framesTotal
      },
      abortController.signal,
    )

    if (result.success && result.outputFilePath) {
      console.log(`[processJob] jobId=${jobId} completed successfully — output=${result.outputFilePath}`)
      job.status = "done"
      job.progress = 100
      job.framesProcessed = job.framesTotal
      job.outputFilePath = result.outputFilePath
      job.completedAt = Date.now()
    } else {
      console.error(`[processJob] jobId=${jobId} failed — ${result.error ?? "Encoding failed"}`)
      job.status = "failed"
      job.error = result.error ?? "Encoding failed"
      job.completedAt = Date.now()
    }
  } catch (err) {
    console.error(`[processJob] jobId=${jobId} threw exception:`, err)
    job.status = "failed"
    job.error = err instanceof Error ? err.message : "Unknown error"
    job.completedAt = Date.now()
  } finally {
    queue.markCompleted(jobId)
    console.log(`[processJob] jobId=${jobId} finished, activeJobs=${queue.getActiveCount()}`)
    // Clean up uploaded & output files after a delay
    setTimeout(() => cleanupJobFiles(jobId), config.cleanupAgeMs)
  }
}

function getMimeType(format: string): string {
  const mimeTypes: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
  }
  return mimeTypes[format] ?? "video/mp4"
}