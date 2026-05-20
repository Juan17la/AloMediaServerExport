import type { RenderPlan, ExportJob, RenderSegment, RenderTransition, MediaProbeResult } from "../types.js"
import { buildFilterGraph } from "./filterGraphBuilder.js"
import { buildServerCommand } from "./commandBuilder.js"
import { runFfmpeg } from "./encoder.js"
import { concatenateSegments } from "./concat.js"
import { config } from "../config.js"
import { join } from "node:path"
import { unlink } from "node:fs/promises"

export interface ChunkedEncodeResult {
  success: boolean
  outputFilePath: string | null
  error: string | null
  framesProcessed: number
}

const DEFAULT_CHUNK_DURATION_S = 120

interface TimeChunk {
  start: number
  end: number
}

function splitTimelineIntoChunks(
  projectDuration: number,
  chunkDurationS: number,
  transitions: RenderTransition[],
): TimeChunk[] {
  const chunks: TimeChunk[] = []
  let currentStart = 0

  while (currentStart < projectDuration) {
    let proposedEnd = Math.min(currentStart + chunkDurationS, projectDuration)

    // Extend chunk to include any transition that crosses the boundary.
    // Without this, a transition would be cut in half between chunks.
    let extended = true
    while (extended) {
      extended = false
      for (const t of transitions) {
        if (t.startTimeS < proposedEnd && t.endTimeS > proposedEnd) {
          const newEnd = Math.min(t.endTimeS, projectDuration)
          if (newEnd > proposedEnd) {
            proposedEnd = newEnd
            extended = true
          }
        }
      }
    }

    chunks.push({ start: currentStart, end: proposedEnd })
    currentStart = proposedEnd
  }

  return chunks
}

function adjustSegmentForChunk(seg: RenderSegment, chunkStart: number, chunkEnd: number): RenderSegment | null {
  const overlapStart = Math.max(seg.timelineStart, chunkStart)
  const overlapEnd = Math.min(seg.timelineEnd, chunkEnd)
  if (overlapStart >= overlapEnd) return null

  const speed = seg.speed ?? 1.0
  const timelineOffset = overlapStart - seg.timelineStart
  const mediaOffset = timelineOffset * speed

  const adjusted: RenderSegment = {
    ...seg,
    timelineStart: overlapStart - chunkStart,
    timelineEnd: overlapEnd - chunkStart,
    mediaStart: seg.mediaStart + mediaOffset,
    mediaEnd: Math.min(seg.mediaEnd, seg.mediaStart + mediaOffset + (overlapEnd - overlapStart) * speed),
  }

  return adjusted
}

function adjustTransitionForChunk(t: RenderTransition, chunkStart: number, chunkEnd: number): RenderTransition | null {
  if (t.startTimeS >= chunkEnd || t.endTimeS <= chunkStart) return null

  const clampedStart = Math.max(t.startTimeS, chunkStart) - chunkStart
  const clampedEnd = Math.min(t.endTimeS, chunkEnd) - chunkStart

  return {
    ...t,
    startTimeS: clampedStart,
    endTimeS: clampedEnd,
    boundaryTimeS: t.boundaryTimeS - chunkStart,
    durationS: clampedEnd - clampedStart,
  }
}

function buildChunkPlan(originalPlan: RenderPlan, chunkStart: number, chunkEnd: number): RenderPlan {
  const chunkDuration = chunkEnd - chunkStart

  const adjustedSegments: RenderSegment[] = []
  for (const seg of originalPlan.segments) {
    const adjusted = adjustSegmentForChunk(seg, chunkStart, chunkEnd)
    if (adjusted) {
      adjustedSegments.push(adjusted)
    }
  }

  const adjustedTransitions: RenderTransition[] = []
  for (const t of originalPlan.transitions) {
    const adjusted = adjustTransitionForChunk(t, chunkStart, chunkEnd)
    if (adjusted) {
      adjustedTransitions.push(adjusted)
    }
  }

  return {
    ...originalPlan,
    projectDuration: chunkDuration,
    segments: adjustedSegments,
    transitions: adjustedTransitions,
    estimatedTotalFrames: Math.max(1, Math.ceil(chunkDuration * originalPlan.outputTarget.fps)),
    canStreamCopy: false,
    streamCopySegments: [],
  }
}

export async function executeChunkedEncode(
  job: ExportJob,
  plan: RenderPlan,
  probeResultsMap: Map<string, MediaProbeResult>,
  assetPaths: Map<string, string>,
  textImagePaths: Map<string, string>,
  gpuCodec: string | null,
  onProgress: (status: string, progress: number, framesProcessed: number, framesTotal: number) => void,
  abortSignal?: AbortSignal,
): Promise<ChunkedEncodeResult> {
  const chunkDurationS = config.chunkDurationS || DEFAULT_CHUNK_DURATION_S
  const chunks = splitTimelineIntoChunks(plan.projectDuration, chunkDurationS, plan.transitions)

  console.log(`[chunkedEncoder] jobId=${job.id} — Split into ${chunks.length} chunks (max=${chunkDurationS}s)`)

  const { outputTarget } = plan
  const outputPath = join(config.tempDir, "outputs", `${job.id}.${outputTarget.format}`)
  const chunkFiles: string[] = []

  let totalFramesProcessed = 0
  const totalFrames = plan.estimatedTotalFrames

  for (let i = 0; i < chunks.length; i++) {
    if (abortSignal?.aborted) {
      return { success: false, outputFilePath: null, error: "Export was cancelled", framesProcessed: totalFramesProcessed }
    }

    const { start, end } = chunks[i]
    const chunkDuration = end - start
    console.log(`[chunkedEncoder] jobId=${job.id} — Encoding chunk ${i + 1}/${chunks.length} [${start.toFixed(2)}s - ${end.toFixed(2)}s]`)

    const chunkPlan = buildChunkPlan(plan, start, end)
    const chunkOutputPath = join(config.tempDir, "outputs", `job_${job.id}_chunk_${i}.${outputTarget.format}`)
    let chunkSuccess = false

    if (chunkPlan.segments.length === 0) {
      // Blank chunk — encode transparent frame with lavfi
      const blankArgs = [
        "-y",
        "-nostdin",
        "-f", "lavfi",
        "-i", `color=c=black@0:s=${outputTarget.resolution.width}x${outputTarget.resolution.height}:r=${outputTarget.fps}:d=${chunkDuration.toFixed(3)}`,
        "-pix_fmt", outputTarget.pixelFormat,
        "-c:v", gpuCodec ? gpuCodec : "libx264",
        "-preset", "ultrafast",
        "-crf", "30",
        "-an",
        chunkOutputPath,
      ]

      const result = await runFfmpeg(blankArgs, job, () => {}, abortSignal)
      chunkSuccess = result.exitCode === 0 && !result.error
      if (!chunkSuccess) {
        return {
          success: false,
          outputFilePath: null,
          error: `Blank chunk ${i + 1} failed: ${result.error ?? "unknown error"}`,
          framesProcessed: totalFramesProcessed,
        }
      }
    } else {
      const graph = buildFilterGraph(
        chunkPlan,
        probeResultsMap,
        assetPaths,
        textImagePaths,
        chunkDuration, // override project duration for correct track padding
      )
      const args = buildServerCommand(graph, chunkPlan, chunkOutputPath, gpuCodec, "fast")

      console.log(`[chunkedEncoder] jobId=${job.id} — Chunk ${i + 1} inputs=${graph.inputArgs.length} filters=${graph.filterComplex.length} chars`)

      const chunkEstimatedFrames = Math.ceil(chunkDuration * outputTarget.fps)
      const result = await runFfmpeg(args, job, (frames) => {
        const overallProgress = Math.min(80, Math.floor(((totalFramesProcessed + frames) / totalFrames) * 80))
        onProgress("encoding", 12 + overallProgress, totalFramesProcessed + frames, totalFrames)
      }, abortSignal)

      chunkSuccess = result.exitCode === 0 && !result.error
      if (!chunkSuccess) {
        const isOom = result.signal === "SIGKILL"
        const errorMsg = isOom
          ? `Chunk ${i + 1}/${chunks.length} failed — server ran out of memory. Try a shorter video or fewer effects.`
          : `Chunk ${i + 1}/${chunks.length} failed: ${result.error ?? "encoding error"}\n${result.stderr.slice(-1000)}`

        // Clean up all intermediate chunk files on failure
        for (const f of chunkFiles) {
          await unlink(f).catch(() => {})
        }
        await unlink(chunkOutputPath).catch(() => {})

        return {
          success: false,
          outputFilePath: null,
          error: errorMsg,
          framesProcessed: totalFramesProcessed,
        }
      }

      totalFramesProcessed += chunkEstimatedFrames
    }

    chunkFiles.push(chunkOutputPath)
    const overallPct = Math.min(98, 12 + Math.floor((chunkFiles.length / chunks.length) * 80))
    onProgress("encoding", overallPct, totalFramesProcessed, totalFrames)
  }

  // Concatenate all chunks
  console.log(`[chunkedEncoder] jobId=${job.id} — Concatenating ${chunkFiles.length} chunks...`)
  onProgress("merging", 92, totalFramesProcessed, totalFrames)

  try {
    await concatenateSegments(chunkFiles, outputPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Clean up on concat failure too
    for (const f of chunkFiles) {
      await unlink(f).catch(() => {})
    }
    return { success: false, outputFilePath: null, error: `Concatenation failed: ${msg}`, framesProcessed: totalFramesProcessed }
  }

  // Clean up intermediate chunk files
  for (const f of chunkFiles) {
    await unlink(f).catch(() => {})
  }

  onProgress("finalizing", 98, totalFrames, totalFrames)
  console.log(`[chunkedEncoder] jobId=${job.id} — Finished successfully`)
  return { success: true, outputFilePath: outputPath, error: null, framesProcessed: totalFrames }
}
