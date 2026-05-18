import { config } from "../config.js"
import type { MediaProbeResult } from "../types.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function probeMediaFile(filePath: string, mediaId: string): Promise<MediaProbeResult> {
  try {
    const { stdout } = await execFileAsync(config.ffprobePath, [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      filePath,
    ])

    const data = JSON.parse(stdout)
    const videoStream = data.streams?.find((s: any) => s.codec_type === "video") ?? null
    const audioStream = data.streams?.find((s: any) => s.codec_type === "audio") ?? null
    const format = data.format ?? {}

    const duration = parseFloat(format.duration ?? "0")

    return {
      mediaId,
      fileHash: "",
      codec: videoStream?.codec_name ?? "h264",
      width: videoStream?.width ?? 1280,
      height: videoStream?.height ?? 720,
      fps: parseFraction(videoStream?.r_frame_rate ?? "30/1"),
      duration,
      isVfr: (videoStream?.r_frame_rate ?? "") !== (videoStream?.avg_frame_rate ?? ""),
      pixelFormat: videoStream?.pix_fmt ?? "yuv420p",
      audioCodec: audioStream?.codec_name ?? "aac",
      audioSampleRate: audioStream?.sample_rate ?? 44100,
      audioChannels: audioStream?.channels ?? 2,
      audioBitrate: parseInt(audioStream?.bit_rate ?? "128000") / 1000,
      fileExtension: filePath.split(".").pop()?.toLowerCase() ?? "mp4",
    }
  } catch (err) {
    return {
      mediaId,
      fileHash: "",
      codec: "h264",
      width: 1280,
      height: 720,
      fps: 30,
      duration: 0,
      isVfr: false,
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      audioSampleRate: 44100,
      audioChannels: 2,
      audioBitrate: 128,
      fileExtension: filePath.split(".").pop()?.toLowerCase() ?? "mp4",
    }
  }
}

function parseFraction(str: string): number {
  const parts = str.split("/")
  if (parts.length === 2) {
    const num = parseFloat(parts[0])
    const den = parseFloat(parts[1])
    return den !== 0 ? num / den : 30
  }
  return parseFloat(str) || 30
}