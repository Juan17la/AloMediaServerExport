import { config } from "../config.js"
import type { ExportJob } from "../types.js"
import { spawn, type ChildProcess } from "node:child_process"
import { writeFileSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

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
  job: ExportJob,
  onProgress: (framesProcessed: number, fps: number, timeS: number) => void,
  abortSignal?: AbortSignal,
): Promise<EncoderResult> {
  const fontconfigDir = mkdtempSync(join(tmpdir(), "alomedia-fc-"))
  const fontconfigContent = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${config.fontDir.replace(/\\/g, "/")}</dir>
</fontconfig>`
  const fontconfigPath = join(fontconfigDir, "fonts.conf")
  writeFileSync(fontconfigPath, fontconfigContent)

  console.log(`[encoder] jobId=${job.id} — FFmpeg args: ${args.join(" ")}`)
  console.log(`[encoder] jobId=${job.id} — FONTCONFIG_FILE=${fontconfigPath}`)

  return new Promise((resolve) => {
    const ffmpegPath = config.ffmpegPath
    const child: ChildProcess = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        FONTCONFIG_FILE: fontconfigPath,
        FONTCONFIG_PATH: fontconfigDir,
      },
    })

    let lastFrames = 0
    let lastFps = 0
    let lastTime = 0
    let stderrBuffer = ""
    let lastDataTime = Date.now()
    let hasLoggedStart = false

    // Defensive timeout: if FFmpeg produces no stderr data in 60s, kill it.
    // This prevents jobs from hanging silently.
    const timeoutMs = 60000
    const timeoutCheck = setInterval(() => {
      const elapsed = Date.now() - lastDataTime
      if (elapsed > timeoutMs) {
        console.error(`[encoder] jobId=${job.id} — Timeout: no stderr data for ${elapsed}ms. Killing FFmpeg.`)
        child.kill("SIGKILL")
      }
    }, 5000)

    child.stdout?.on("data", () => {
      // Discard stdout
    })

    child.stderr?.on("data", (data: Buffer) => {
      lastDataTime = Date.now()
      if (!hasLoggedStart) {
        hasLoggedStart = true
        console.log(`[encoder] jobId=${job.id} — FFmpeg started producing stderr data`)
      }

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
        console.log(`[encoder] jobId=${job.id} — Abort signal received, killing FFmpeg`)
        child.kill("SIGKILL")
      })
    }

    child.on("close", (code, signal) => {
      clearInterval(timeoutCheck)
      console.log(`[encoder] jobId=${job.id} — FFmpeg closed — exitCode=${code}, signal=${signal}, frames=${lastFrames}, fps=${lastFps}`)
      resolve({
        exitCode: code,
        signal: signal,
        error: code !== 0 ? `FFmpeg exited with code ${code}` : null,
        stderr: stderrBuffer,
      })
    })

    child.on("error", (err) => {
      clearInterval(timeoutCheck)
      console.error(`[encoder] jobId=${job.id} — FFmpeg spawn error: ${err.message}`)
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