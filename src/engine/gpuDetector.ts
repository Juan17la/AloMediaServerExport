import { config } from "../config.js"
import type { GpuCapabilities } from "../types.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const CPU_ONLY: GpuCapabilities = {
  nvenc: false,
  qsv: false,
  vaapi: false,
  selectedEncoder: "libx264",
  selectedCodec: "h264",
}

let cachedCapabilities: GpuCapabilities | null = null

async function checkEncoderAvailable(encoder: string, timeoutMs: number = 5000): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(config.ffmpegPath, ["-hide_banner", "-encoders"], {
      timeout: timeoutMs,
    })
    return stdout.includes(encoder)
  } catch {
    return false
  }
}

async function checkHwAccelAvailable(hwAccel: string, timeoutMs: number = 5000): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(config.ffmpegPath, ["-hide_banner", "-hwaccels"], {
      timeout: timeoutMs,
    })
    return stdout.includes(hwAccel)
  } catch {
    return false
  }
}

export async function detectGpuCapabilities(): Promise<GpuCapabilities> {
  if (cachedCapabilities) return cachedCapabilities

  // If GPU is explicitly disabled, skip detection entirely to avoid
  // hanging on ghost NVIDIA drivers in cloud containers.
  if (!config.enableGpu) {
    console.log("[gpuDetector] ENABLE_GPU=false — forcing CPU-only encoding (libx264)")
    cachedCapabilities = { ...CPU_ONLY }
    return cachedCapabilities
  }

  console.log("[gpuDetector] Detecting GPU capabilities...")

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

  console.log(`[gpuDetector] Detected: nvenc=${nvenc}, qsv=${qsv}, vaapi=${vaapi}, cuda=${cuda}, selectedEncoder=${selectedEncoder}`)

  return cachedCapabilities
}

export function invalidateGpuCache(): void {
  cachedCapabilities = null
}