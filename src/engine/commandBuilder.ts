import type { RenderPlan, FilterGraphResult } from "../types.js"

const ENCODING_PRESETS: Record<string, { codec: string; preset: string; crf: number; audioBitrate: number }> = {
  fast: { codec: "libx264", preset: "ultrafast", crf: 30, audioBitrate: 128 },
  medium: { codec: "libx264", preset: "fast", crf: 26, audioBitrate: 192 },
  slow: { codec: "libx264", preset: "medium", crf: 22, audioBitrate: 256 },
}

const GPU_PRESETS_NVENC: Record<string, { codec: string; preset: string; crf: number; audioBitrate: number }> = {
  fast: { codec: "h264_nvenc", preset: "p1", crf: 30, audioBitrate: 128 },
  medium: { codec: "h264_nvenc", preset: "p4", crf: 26, audioBitrate: 192 },
  slow: { codec: "h264_nvenc", preset: "p7", crf: 22, audioBitrate: 256 },
}

const GPU_PRESETS_QSV: Record<string, { codec: string; preset: string; crf: number; audioBitrate: number }> = {
  fast: { codec: "h264_qsv", preset: "veryfast", crf: 30, audioBitrate: 128 },
  medium: { codec: "h264_qsv", preset: "medium", crf: 26, audioBitrate: 192 },
  slow: { codec: "h264_qsv", preset: "slow", crf: 22, audioBitrate: 256 },
}

const FAST_CODEC_ARGS: Record<string, string[]> = {
  h264: ["-profile:v", "baseline", "-level", "3.1"],
  vp9: ["-row-mt", "1", "-threads", "4"],
  av1: ["-cpu-used", "8", "-row-mt", "1"],
}

function getPresetConfig(preset: string, gpuCodec: string | null) {
  if (gpuCodec) {
    if (gpuCodec.includes("nvenc")) {
      return GPU_PRESETS_NVENC[preset] ?? GPU_PRESETS_NVENC.fast
    }
    if (gpuCodec.includes("qsv")) {
      return GPU_PRESETS_QSV[preset] ?? GPU_PRESETS_QSV.fast
    }
  }
  return ENCODING_PRESETS[preset] ?? ENCODING_PRESETS.fast
}

export function buildServerCommand(
  graph: FilterGraphResult,
  plan: RenderPlan,
  outputFile: string,
  gpuCodec: string | null,
  encodingPreset: string,
): string[] {
  const { outputTarget } = plan
  const args: string[] = ["-y"]

  // Use consistent scaling algorithm for all sws operations (including
  // auto-inserted scale filters) to prevent "Failed to configure
  // output pad" errors on complex filter graphs.
  args.push("-sws_flags", "lanczos+accurate_rnd")

  // Note: -hwaccel flags are intentionally omitted. When using -filter_complex,
  // FFmpeg operates in software. GPU encoding (h264_nvenc/h264_qsv) still works
  // without hwaccel — it just means software decoding + filtering, then GPU encode.

  for (const inputArg of graph.inputArgs) {
    args.push(inputArg)
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

  const presetConfig = getPresetConfig(encodingPreset, gpuCodec)

  if (gpuCodec) {
    args.push("-c:v", presetConfig.codec)
  } else {
    const codecName = mapCodecForNative(outputTarget.codec as string)
    args.push("-c:v", codecName)
  }

  // CRF is not valid for most GPU encoders — use -qp or -b:v instead
  if (gpuCodec) {
    const qpValue = presetConfig.crf
    args.push("-qp", String(qpValue))
  } else {
    args.push("-crf", String(presetConfig.crf))
  }

  args.push("-preset", presetConfig.preset)

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
  const args: string[] = ["-y"]

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