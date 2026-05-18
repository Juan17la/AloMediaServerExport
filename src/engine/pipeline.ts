import type { RenderPlan, ExportJob } from "../types.js"
import { config } from "../config.js"
import { detectGpuCapabilities } from "./gpuDetector.js"
import { buildServerCommand, buildStreamCopyCommand } from "./commandBuilder.js"
import { buildFilterGraph } from "./filterGraphBuilder.js"
import { runFfmpeg } from "./encoder.js"
import { join } from "node:path"
import { probeMediaFile } from "./probe.js"

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
  const { outputTarget } = plan

  onProgress("probing", 3, 0, plan.estimatedTotalFrames)

  // Build probe results from the plan (client sends probe data)
  const probeResults = new Map(plan.probeResults.map((p) => [p.mediaId, p]))

  // Re-probe server-side saved assets for additional verification
  for (const [mediaId, filePath] of assetPaths) {
    if (!probeResults.has(mediaId)) {
      try {
        const probe = await probeMediaFile(filePath, mediaId)
        probeResults.set(mediaId, probe)
      } catch (err) {
        console.warn(`[pipeline] Failed to probe ${mediaId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const gpuCapabilities = await detectGpuCapabilities()
  const gpuCodec = config.enableGpu ? gpuCapabilities.selectedCodec : null

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
      console.error("[pipeline] Stream copy failed with exit code:", result.exitCode)
      console.error("[pipeline] FFmpeg stderr (last 2000 chars):", stderrTail)
      const errorDetail = result.error ?? `FFmpeg exited with code ${result.exitCode}`
      return { success: false, outputFilePath: null, error: `${errorDetail}\n${stderrTail}`, framesProcessed: 0 }
    }

    onProgress("finalizing", 98, plan.estimatedTotalFrames, plan.estimatedTotalFrames)
    return { success: true, outputFilePath: outputPath, error: null, framesProcessed: plan.estimatedTotalFrames }
  }

  onProgress("planning", 10, 0, plan.estimatedTotalFrames)

  // Full encode path: build filter graph and encode
  const graph = buildFilterGraph(plan, probeResults, assetPaths)
  const outputPath = join(config.tempDir, `${job.id}.${outputTarget.format}`)

  const encodingPreset = "fast"
  const args = buildServerCommand(graph, plan, outputPath, gpuCodec, encodingPreset)

  console.log("[pipeline] Full encode path. Filter graph inputs:", graph.inputArgs.length, "Filter length:", graph.filterComplex.length)
  console.log("[pipeline] FFmpeg command:", args.join(" "))
  if (graph.filterComplex.length > 0) {
    console.log("[pipeline] Filter complex:\n", graph.filterComplex)
  }

  onProgress("encoding", 12, 0, plan.estimatedTotalFrames)

  const result = await runFfmpeg(args, job, (frames, _fps, _time) => {
    const pct = 12 + Math.min(80, Math.floor((frames / plan.estimatedTotalFrames) * 80))
    onProgress("encoding", pct, frames, plan.estimatedTotalFrames)
  }, abortSignal)

  if (result.error || result.exitCode !== 0) {
    const stderrTail = result.stderr ? result.stderr.slice(-2000) : ""
    console.error("[pipeline] FFmpeg failed with exit code:", result.exitCode)
    console.error("[pipeline] FFmpeg stderr (last 2000 chars):", stderrTail)
    const errorDetail = result.error ?? `FFmpeg exited with code ${result.exitCode}`
    return { success: false, outputFilePath: null, error: `${errorDetail}\n${stderrTail}`, framesProcessed: 0 }
  }

  onProgress("finalizing", 98, plan.estimatedTotalFrames, plan.estimatedTotalFrames)
  return { success: true, outputFilePath: outputPath, error: null, framesProcessed: plan.estimatedTotalFrames }
}