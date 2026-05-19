import { Router, type Request, type Response } from "express"
import multer from "multer"
import { config } from "../config.js"
import { JobQueue, createJobId } from "../queue/jobQueue.js"
import type { ExportJob, RenderPlan } from "../types.js"
import { executePipeline } from "../engine/pipeline.js"
import { saveUploadedAsset, cleanupJobFiles } from "../storage/assetStore.js"
import { stat, readFile } from "node:fs/promises"

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } })

const queue = new JobQueue(config.maxConcurrentJobs)
const jobs = new Map<string, ExportJob>()

export const exportRouter = Router()

exportRouter.post("/export", upload.any(), async (req: Request, res: Response) => {
  try {
    const planJson = req.body.plan
    if (!planJson) {
      const bodyKeys = req.body ? Object.keys(req.body) : []
      const filesCount = Array.isArray(req.files) ? req.files.length : req.files ? 1 : 0
      console.warn("/export called without plan", { bodyKeys, filesCount, contentType: req.get("content-type") })
      res.status(400).json({ error: "Missing plan", bodyKeys, filesCount, contentType: req.get("content-type") })
      return
    }

    const plan: RenderPlan = typeof planJson === "string" ? JSON.parse(planJson) : planJson

    const jobId = createJobId()
    const files = req.files as Express.Multer.File[]

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

    // Process asynchronously
    processJob(jobId, plan, files).catch((err) => {
      const storedJob = jobs.get(jobId)
      if (storedJob) {
        storedJob.status = "failed"
        storedJob.error = err instanceof Error ? err.message : "Unknown error"
        storedJob.completedAt = Date.now()
      }
    })

    res.json({ jobId })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" })
  }
})

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

async function processJob(jobId: string, plan: RenderPlan, files: Express.Multer.File[]): Promise<void> {
  const job = jobs.get(jobId)
  if (!job) return

  job.status = "probing"
  job.startedAt = Date.now()

  // Save uploaded assets to disk
  const assetPaths = new Map<string, string>()
  for (const file of files) {
    const mediaId = file.fieldname.replace("file_", "")
    const filePath = await saveUploadedAsset(jobId, mediaId, file.buffer, file.originalname)
    assetPaths.set(mediaId, filePath)
  }

  job.status = "encoding"
  queue.markActive(jobId)

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
      job.status = "done"
      job.progress = 100
      job.framesProcessed = job.framesTotal
      job.outputFilePath = result.outputFilePath
      job.completedAt = Date.now()
    } else {
      job.status = "failed"
      job.error = result.error ?? "Encoding failed"
      job.completedAt = Date.now()
    }
  } catch (err) {
    job.status = "failed"
    job.error = err instanceof Error ? err.message : "Unknown error"
    job.completedAt = Date.now()
  } finally {
    queue.markCompleted(jobId)
    // Clean up asset files after a delay
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