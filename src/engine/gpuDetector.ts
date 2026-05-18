import { config } from "../config.js"
import type { GpuCapabilities } from "../types.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

let cachedCapabilities: GpuCapabilities | null = null

async function checkEncoderAvailable(encoder: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(config.ffmpegPath, ["-hide_banner", "-encoders"])
    return stdout.includes(encoder)
  } catch {
    return false
  }
}

async function checkHwAccelAvailable(hwAccel: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(config.ffmpegPath, ["-hide_banner", "-hwaccels"])
    return stdout.includes(hwAccel)
  } catch {
    return false
  }
}

export async function detectGpuCapabilities(): Promise<GpuCapabilities> {
  if (cachedCapabilities) return cachedCapabilities

  const [nvenc, qsv, vaapi, cuda, qsvHwAccel] = await Promise.all([
    checkEncoderAvailable("h264_nvenc"),
    checkEncoderAvailable("h264_qsv"),
    checkEncoderAvailable("h264_vaapi"),
    checkHwAccelAvailable("cuda"),
    checkHwAccelAvailable("qsv"),
  ])

  let selectedEncoder = "libx264"
  let selectedCodec = "h264"

  if (nvenc && cuda) {
    selectedEncoder = "h264_nvenc"
    selectedCodec = "h264_nvenc"
  } else if (qsv && qsvHwAccel) {
    selectedEncoder = "h264_qsv"
    selectedCodec = "h264_qsv"
  } else if (vaapi) {
    selectedEncoder = "h264_vaapi"
    selectedCodec = "h264_vaapi"
  }

  cachedCapabilities = {
    nvenc: nvenc && cuda,
    qsv: qsv && qsvHwAccel,
    vaapi,
    selectedEncoder,
    selectedCodec,
  }

  return cachedCapabilities
}

export function invalidateGpuCache(): void {
  cachedCapabilities = null
}