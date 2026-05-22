import type { RenderPlan, ExportJob, RenderSegment, RenderTransition, MediaProbeResult } from "../types.js"
import { buildFilterGraph } from "./filterGraphBuilder.js"
import { buildServerCommand } from "./commandBuilder.js"
import { runFfmpeg } from "./encoder.js"
import { concatenateSegments, remuxToFormat } from "./concat.js"
import { config } from "../config.js"
import { join } from "node:path"
import { unlink } from "node:fs/promises"

export interface ChunkedEncodeResult {
  success: boolean
  outputFilePath: string | null
  error: string | null
  framesProcessed: number
}

const DEFAULT_CHUNK_DURATION_S = 30
const MIN_CHUNK_SIZE_S = 5

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

interface ChunkTask {
  start: number
  end: number
  outputPath: string
}

async function encodeChunk(
  job: ExportJob,
  plan: RenderPlan,
  probeResultsMap: Map<string, MediaProbeResult>,
  assetPaths: Map<string, string>,
  textImagePaths: Map<string, string>,
  gpuCodec: string | null,
  task: ChunkTask,
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; outputPath: string | null; error?: string }> {
  const chunkDuration = task.end - task.start

  const chunkPlan = buildChunkPlan(plan, task.start, task.end)

  if (chunkPlan.segments.length === 0) {
    // Blank chunk — encode transparent frame with lavfi
    const blankArgs = [
      "-y",
      "-nostdin",
      "-f", "lavfi",
      "-i", `color=c=black@0:s=${plan.outputTarget.resolution.width}x${plan.outputTarget.resolution.height}:r=${plan.outputTarget.fps}:d=${chunkDuration.toFixed(3)}`,
      "-t", chunkDuration.toFixed(3),
      "-pix_fmt", plan.outputTarget.pixelFormat,
      "-c:v", gpuCodec || "libx264",
      "-preset", "ultrafast",
      "-crf", "30",
      "-an",
      task.outputPath,
    ]

    const result = await runFfmpeg(blankArgs, job, () => {}, abortSignal)
    if (result.exitCode === 0 && !result.error) {
      return { success: true, outputPath: task.outputPath }
    }
    return { success: false, outputPath: null, error: `Blank chunk [${task.start.toFixed(2)}-${task.end.toFixed(2)}s] failed: ${result.error ?? "unknown error"}` }
  }

  const graph = buildFilterGraph(
    chunkPlan,
    probeResultsMap,
    assetPaths,
    textImagePaths,
    chunkDuration,
  )
  const args = buildServerCommand(graph, chunkPlan, task.outputPath, gpuCodec)

  // DEBUG: log full filter graph for diagnosis
  console.log(`[chunkedEncoder] jobId=${job.id} — Chunk [${task.start.toFixed(2)}-${task.end.toFixed(2)}s] INPUT ARGS:`)
  console.log(graph.inputArgs.join(" "))
  console.log(`[chunkedEncoder] jobId=${job.id} — Chunk [${task.start.toFixed(2)}-${task.end.toFixed(2)}s] FILTER_COMPLEX:`)
  console.log(graph.filterComplex)
  console.log(`[chunkedEncoder] jobId=${job.id} — Chunk [${task.start.toFixed(2)}-${task.end.toFixed(2)}s] MAPPING ARGS:`)
  console.log(graph.mappingArgs.join(" "))

  const result = await runFfmpeg(args, job, () => {}, abortSignal)

  if (result.exitCode === 0 && !result.error) {
    return { success: true, outputPath: task.outputPath }
  }

  // OOM auto-retry: if killed by SIGKILL and chunk is still splittable, split in half and retry
  if (result.signal === "SIGKILL" && chunkDuration > MIN_CHUNK_SIZE_S) {
    console.log(`[chunkedEncoder] jobId=${job.id} — OOM on chunk [${task.start.toFixed(2)}-${task.end.toFixed(2)}s], splitting in half and retrying...`)

    const mid = task.start + chunkDuration / 2
    const leftPath = task.outputPath.replace(/(\.[^.]+)$/, `_retry_l$1`)
    const rightPath = task.outputPath.replace(/(\.[^.]+)$/, `_retry_r$1`)

    const leftResult = await encodeChunk(job, plan, probeResultsMap, assetPaths, textImagePaths, gpuCodec, { start: task.start, end: mid, outputPath: leftPath }, abortSignal)
    if (!leftResult.success) {
      await unlink(leftPath).catch(() => {})
      await unlink(rightPath).catch(() => {})
      return { success: false, outputPath: null, error: leftResult.error }
    }

    const rightResult = await encodeChunk(job, plan, probeResultsMap, assetPaths, textImagePaths, gpuCodec, { start: mid, end: task.end, outputPath: rightPath }, abortSignal)
    if (!rightResult.success) {
      await unlink(leftPath).catch(() => {})
      await unlink(rightPath).catch(() => {})
      return { success: false, outputPath: null, error: rightResult.error }
    }

    // Concatenate left and right into the expected output path
    try {
      await concatenateSegments([leftPath, rightPath], task.outputPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await unlink(leftPath).catch(() => {})
      await unlink(rightPath).catch(() => {})
      return { success: false, outputPath: null, error: `Concat after OOM retry failed: ${msg}` }
    }

    await unlink(leftPath).catch(() => {})
    await unlink(rightPath).catch(() => {})

    return { success: true, outputPath: task.outputPath }
  }

  return {
    success: false,
    outputPath: null,
    error: result.error ?? `FFmpeg exited with code ${result.exitCode}`,
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
    console.log(`[chunkedEncoder] jobId=${job.id} — Encoding chunk ${i + 1}/${chunks.length} [${start.toFixed(2)}s - ${end.toFixed(2)}s]`)

    const chunkOutputPath = join(config.tempDir, "outputs", `job_${job.id}_chunk_${i}.ts`)
    const encodeResult = await encodeChunk(
      job,
      plan,
      probeResultsMap,
      assetPaths,
      textImagePaths,
      gpuCodec,
      { start, end, outputPath: chunkOutputPath },
      abortSignal,
    )

    if (!encodeResult.success) {
      // Clean up all intermediate chunk files on failure
      for (const f of chunkFiles) {
        await unlink(f).catch(() => {})
      }
      await unlink(chunkOutputPath).catch(() => {})
      return { success: false, outputFilePath: null, error: encodeResult.error ?? null, framesProcessed: totalFramesProcessed }
    }

    chunkFiles.push(encodeResult.outputPath!)
    const chunkEstimatedFrames = Math.ceil((end - start) * outputTarget.fps)
    totalFramesProcessed += chunkEstimatedFrames

    const overallPct = Math.min(98, 12 + Math.floor((chunkFiles.length / chunks.length) * 80))
    onProgress("encoding", overallPct, totalFramesProcessed, totalFrames)
  }

  // Concatenate all chunks into a TS file first (avoids MP4 atom boundary issues)
  const concatPath = join(config.tempDir, "outputs", `${job.id}_concat.ts`)
  console.log(`[chunkedEncoder] jobId=${job.id} — Concatenating ${chunkFiles.length} chunks into TS...`)
  onProgress("merging", 92, totalFramesProcessed, totalFrames)

  try {
    await concatenateSegments(chunkFiles, concatPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    for (const f of chunkFiles) {
      await unlink(f).catch(() => {})
    }
    await unlink(concatPath).catch(() => {})
    return { success: false, outputFilePath: null, error: `Concatenation failed: ${msg}`, framesProcessed: totalFramesProcessed }
  }

  // Remux TS to final target format
  onProgress("finalizing", 95, totalFramesProcessed, totalFrames)
  try {
    await remuxToFormat(concatPath, outputPath, outputTarget.format)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    for (const f of chunkFiles) {
      await unlink(f).catch(() => {})
    }
    await unlink(concatPath).catch(() => {})
    return { success: false, outputFilePath: null, error: `Remux failed: ${msg}`, framesProcessed: totalFramesProcessed }
  }

  // Clean up intermediate chunk files and concat file
  for (const f of chunkFiles) {
    await unlink(f).catch(() => {})
  }
  await unlink(concatPath).catch(() => {})

  onProgress("finalizing", 98, totalFramesProcessed, totalFrames)
  console.log(`[chunkedEncoder] jobId=${job.id} — Finished successfully`)
  return { success: true, outputFilePath: outputPath, error: null, framesProcessed: totalFrames }
}
