import { config } from "../config.js"
import type { ExportJob } from "../types.js"
import { spawn, type ChildProcess } from "node:child_process"

const FRAME_REGEX = /frame=\s*(\d+)/
const FPS_REGEX = /fps=\s*([\d.]+)/
const TIME_REGEX = /time=\s*([\d:.]+)/
const PROGRESS_REGEX = /^frame=\s*\d+/

export interface EncoderResult {
  exitCode: number | null
  signal: string | null
  error: string | null
  stderr: string
}

export async function runFfmpeg(
  args: string[],
  _job: ExportJob,
  onProgress: (framesProcessed: number, fps: number, timeS: number) => void,
  abortSignal?: AbortSignal,
): Promise<EncoderResult> {
  return new Promise((resolve) => {
    const ffmpegPath = config.ffmpegPath
    const child: ChildProcess = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    })

    let lastFrames = 0
    let lastFps = 0
    let lastTime = 0
    let stderrBuffer = ""

    child.stdout?.on("data", () => {
      // Discard stdout
    })

    child.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString()
      stderrBuffer += chunk
      const lines = chunk.split("\n")
      for (const line of lines) {
        if (PROGRESS_REGEX.test(line)) {
          const frameMatch = line.match(FRAME_REGEX)
          const fpsMatch = line.match(FPS_REGEX)
          const timeMatch = line.match(TIME_REGEX)

          if (frameMatch) {
            lastFrames = parseInt(frameMatch[1], 10)
          }
          if (fpsMatch) {
            lastFps = parseFloat(fpsMatch[1]) || 0
          }
          if (timeMatch) {
            lastTime = parseTimeToSeconds(timeMatch[1])
          }

          onProgress(lastFrames, lastFps, lastTime)
        }
      }
    })

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        child.kill("SIGKILL")
      })
    }

    child.on("close", (code, signal) => {
      resolve({
        exitCode: code,
        signal: signal,
        error: code !== 0 ? `FFmpeg exited with code ${code}` : null,
        stderr: stderrBuffer,
      })
    })

    child.on("error", (err) => {
      resolve({
        exitCode: null,
        signal: null,
        error: err.message,
        stderr: stderrBuffer,
      })
    })
  })
}

function parseTimeToSeconds(timeStr: string): number {
  const parts = timeStr.split(":")
  if (parts.length !== 3) return 0
  const hours = parseFloat(parts[0])
  const minutes = parseFloat(parts[1])
  const seconds = parseFloat(parts[2])
  return hours * 3600 + minutes * 60 + seconds
}