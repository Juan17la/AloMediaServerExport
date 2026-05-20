import type { RenderPlan, ExportJob } from "../types.js"
import { config } from "../config.js"
import { detectGpuCapabilities } from "./gpuDetector.js"
import { buildStreamCopyCommand } from "./commandBuilder.js"
import { runFfmpeg } from "./encoder.js"
import { join } from "node:path"
import { probeMediaFile } from "./probe.js"
import { renderTextSegmentsToFiles } from "./textRenderer.js"
import { executeChunkedEncode } from "./chunkedEncoder.js"

export interface PipelineResult {
  success: boolean
  outputFilePath: string | null
  error: string | null
  framesProcessed: number
}

export async function executePipeline(
  job: ExportJob,
  plan: RenderPlan,
  assetPaths: Map<string, string>,
  onProgress: (status: string, progress: number, framesProcessed: number, framesTotal: number) => void,
  abortSignal?: AbortSignal,
): Promise<PipelineResult> {
  console.log(`[pipeline] Starting pipeline for jobId=${job.id}`)
  const { outputTarget } = plan

  onProgress("probing", 3, 0, plan.estimatedTotalFrames)

  // Build probe results from the plan (client sends probe data)
  const probeResults = new Map(plan.probeResults.map((p) => [p.mediaId, p]))

  // Re-probe server-side saved assets and override client-sent probes
  console.log(`[pipeline] Probing ${assetPaths.size} assets...`)
  for (const [mediaId, filePath] of assetPaths) {
    try {
      console.log(`[pipeline] Probing asset mediaId=${mediaId} path=${filePath}`)
      const probe = await probeMediaFile(filePath, mediaId)
      probeResults.set(mediaId, probe)
      console.log(`[pipeline] Probed OK — ${probe.width}x${probe.height}, ${probe.duration}s, codec=${probe.codec}`)
    } catch (err) {
      console.warn(`[pipeline] Failed to probe ${mediaId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log("[pipeline] Detecting GPU capabilities...")
  const gpuCapabilities = await detectGpuCapabilities()
  const gpuCodec = config.enableGpu ? gpuCapabilities.selectedCodec : null
  console.log(`[pipeline] GPU selectedCodec=${gpuCodec ?? "none (CPU)"}, encoder=${gpuCapabilities.selectedEncoder}`)

  onProgress("planning", 8, 0, plan.estimatedTotalFrames)

  // Check if stream copy is possible (single clip, no modifications)
  if (plan.canStreamCopy && plan.streamCopySegments.length === 1) {
    const seg = plan.streamCopySegments[0]
    const inputPath = assetPaths.get(seg.mediaId)
    if (!inputPath) {
      return { success: false, outputFilePath: null, error: `Missing asset: ${seg.mediaId}`, framesProcessed: 0 }
    }

    const outputPath = join(config.tempDir, `${job.id}.${outputTarget.format}`)
    const duration = seg.mediaEnd - seg.mediaStart
    const args = buildStreamCopyCommand(inputPath, outputPath, seg.mediaStart, duration, outputTarget.format)

    console.log("[pipeline] Stream copy path. Command:", args.join(" "))

    onProgress("encoding", 12, 0, plan.estimatedTotalFrames)

    const result = await runFfmpeg(args, job, (frames) => {
      onProgress("encoding", 12 + Math.floor((frames / plan.estimatedTotalFrames) * 80), frames, plan.estimatedTotalFrames)
    }, abortSignal)

    if (result.error || result.exitCode !== 0) {
      const stderrTail = result.stderr ? result.stderr.slice(-2000) : ""
      if (result.killedByAbort) {
        console.log("[pipeline] Stream copy was aborted (job cancelled)")
      } else if (result.killedByTimeout) {
        console.error("[pipeline] Stream copy was killed due to timeout")
      } else if (result.signal === "SIGKILL") {
        console.error("[pipeline] Stream copy was killed by SIGKILL — likely out of memory")
      } else {
        console.error("[pipeline] Stream copy failed with exit code:", result.exitCode)
        console.error("[pipeline] FFmpeg stderr (last 2000 chars):", stderrTail)
      }
      const errorDetail = result.error ?? `FFmpeg exited with code ${result.exitCode}`
      return { success: false, outputFilePath: null, error: result.killedByAbort ? "Export was cancelled" : `${errorDetail}\n${stderrTail}`, framesProcessed: 0 }
    }

    onProgress("finalizing", 98, plan.estimatedTotalFrames, plan.estimatedTotalFrames)
    return { success: true, outputFilePath: outputPath, error: null, framesProcessed: plan.estimatedTotalFrames }
  }

  onProgress("planning", 10, 0, plan.estimatedTotalFrames)

  // Pre-render text segments to PNG files
  console.log(`[pipeline] Pre-rendering text segments... segments=${plan.segments.length}`)
  const textImagePaths = await renderTextSegmentsToFiles(
    plan.segments,
    outputTarget.resolution.width,
    outputTarget.resolution.height,
    config.tempDir,
    job.id,
  )
  console.log(`[pipeline] Text segments rendered — count=${textImagePaths.size}`)

  const result = await executeChunkedEncode(
    job,
    plan,
    probeResults,
    assetPaths,
    textImagePaths,
    gpuCodec,
    onProgress,
    abortSignal,
  )

  if (!result.success) {
    console.error(`[pipeline] jobId=${job.id} failed — ${result.error ?? "Unknown error"}`)
    return { success: false, outputFilePath: null, error: result.error ?? "Encoding failed", framesProcessed: result.framesProcessed }
  }

  onProgress("finalizing", 98, plan.estimatedTotalFrames, plan.estimatedTotalFrames)
  console.log(`[pipeline] Pipeline completed for jobId=${job.id}`)
  return { success: true, outputFilePath: result.outputFilePath, error: null, framesProcessed: result.framesProcessed }
}