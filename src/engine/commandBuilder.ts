import type { RenderPlan, FilterGraphResult } from "../types.js"

const FAST_CODEC_ARGS: Record<string, string[]> = {
  h264: ["-profile:v", "baseline", "-level", "3.1"],
  vp9: ["-row-mt", "1", "-threads", "4"],
  av1: ["-cpu-used", "8", "-row-mt", "1"],
}

export function buildServerCommand(
  graph: FilterGraphResult,
  plan: RenderPlan,
  outputFile: string,
  gpuCodec: string | null,
): string[] {
  const { outputTarget } = plan
  const args: string[] = ["-y", "-nostdin"]

  // Use consistent scaling algorithm for all sws operations (including
  // auto-inserted scale filters) to prevent "Failed to configure
  // output pad" errors on complex filter graphs.
  args.push("-sws_flags", "lanczos+accurate_rnd")

  // Limit threads to reduce memory pressure and prevent multi-threaded
  // filter graph negotiation issues that cause reinitialization failures.
  // On Railway hobby plans (512 MB RAM), a single thread is safer.
  args.push("-threads", "1")
  args.push("-filter_complex_threads", "1")

  // Note: -hwaccel flags are intentionally omitted. When using -filter_complex,
  // FFmpeg operates in software. GPU encoding (h264_nvenc/h264_qsv) still works
  // without hwaccel — it just means software decoding + filtering, then GPU encode.

  // Cap per-input decoder thread queue to prevent FFmpeg from buffering
  // hundreds of frames ahead per input (major RAM spike on multi-input graphs).
  for (let i = 0; i < graph.inputArgs.length; i++) {
    const arg = graph.inputArgs[i]
    if (arg === "-i") {
      args.push("-thread_queue_size", "512")
    }
    args.push(arg)
  }

  if (graph.filterComplex.trim().length > 0) {
    args.push("-filter_complex", graph.filterComplex)
  }

  for (const mapArg of graph.mappingArgs) {
    args.push(mapArg)
  }

  if (graph.mappingArgs.length === 0) {
    args.push("-map", "0:v")
  }

  const effectiveCodec = gpuCodec ?? mapCodecForNative(outputTarget.codec as string)
  args.push("-c:v", effectiveCodec)
  args.push("-crf", String(outputTarget.crf))
  args.push("-preset", outputTarget.preset)

  if (outputTarget.tune && !gpuCodec) {
    args.push("-tune", outputTarget.tune)
  }

  if (!gpuCodec) {
    const codecKey = outputTarget.codec as string
    const codecArgs = FAST_CODEC_ARGS[codecKey] ?? FAST_CODEC_ARGS["h264"]
    args.push(...codecArgs)
  }

  args.push("-pix_fmt", outputTarget.pixelFormat)
  args.push("-r", String(outputTarget.fps))

  if (graph.hasAudioOutput) {
    args.push("-c:a", outputTarget.audioCodec)
    args.push("-b:a", `${outputTarget.audioBitrate}k`)
  } else {
    args.push("-an")
  }

  // Prevent "Buffer queue overflow" errors in complex filter graphs where
  // audio and video streams produce data at significantly different rates.
  args.push("-max_muxing_queue_size", "1024")

  args.push("-progress", "pipe:2")

  if (outputTarget.format === "mp4") {
    args.push("-movflags", "+faststart")
  }

  args.push(outputFile)

  return args
}

export function buildStreamCopyCommand(
  inputFile: string,
  outputFile: string,
  seekStart: number,
  duration: number,
  format: string,
): string[] {
  const args: string[] = ["-y", "-nostdin"]

  if (seekStart > 0.001) {
    args.push("-ss", seekStart.toFixed(3))
  }

  args.push("-i", inputFile)
  args.push("-t", duration.toFixed(3))
  args.push("-c", "copy")
  args.push("-avoid_negative_ts", "make_zero")

  if (format === "mp4") {
    args.push("-movflags", "+faststart")
  }

  args.push(outputFile)
  return args
}

function mapCodecForNative(codec: string): string {
  if (codec === "h264") return "libx264"
  if (codec === "vp9") return "libvpx-vp9"
  if (codec === "av1") return "libaom-av1"
  return codec
}
