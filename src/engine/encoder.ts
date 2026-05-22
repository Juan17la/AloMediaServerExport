import { config } from "../config.js"
import type { ExportJob } from "../types.js"
import { spawn, type ChildProcess } from "node:child_process"
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
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
  killedByTimeout: boolean
  killedByAbort: boolean
}

const STARTUP_TIMEOUT_MS = 120_000
const OVERALL_TIMEOUT_MS = config.jobTimeoutMs || 1_800_000
const MAX_STDERR_BUFFER = 50_000

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

  function cleanupFontconfig() {
    try {
      rmSync(fontconfigDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup failures
    }
  }

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
    let hasStartedEncoding = false
    let killedByTimeout = false
    let killedByAbort = false
    const startTime = Date.now()

    // Startup timeout: kill if FFmpeg produces no progress within the startup period.
    // Once encoding starts (first frame decoded), this is no longer checked — the
    // overall timeout takes over to allow slow complex encodes and finalization.
    const startupCheck = setInterval(() => {
      if (hasStartedEncoding) return
      const elapsed = Date.now() - startTime
      if (elapsed > STARTUP_TIMEOUT_MS) {
        console.error(`[encoder] jobId=${job.id} — Startup timeout: no frames decoded in ${Math.round(elapsed / 1000)}s. Killing FFmpeg.`)
        killedByTimeout = true
        child.kill("SIGKILL")
      }
    }, 5000)

    // Overall timeout: kill if FFmpeg has been running longer than the configured
    // maximum (default 30 minutes). This catches truly hung processes without
    // interfering with long-but-valid encodes or finalization phases.
    const overallTimeout = setTimeout(() => {
      console.error(`[encoder] jobId=${job.id} — Overall timeout: exceeded ${Math.round(OVERALL_TIMEOUT_MS / 1000)}s. Killing FFmpeg.`)
      killedByTimeout = true
      child.kill("SIGKILL")
    }, OVERALL_TIMEOUT_MS)

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        console.log(`[encoder] jobId=${job.id} — Abort signal received, killing FFmpeg`)
        killedByAbort = true
        child.kill("SIGKILL")
      })
    }

    child.stdout?.on("data", () => {
      // Discard stdout
    })

    child.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString()
      stderrBuffer += chunk
      if (stderrBuffer.length > MAX_STDERR_BUFFER) {
        stderrBuffer = stderrBuffer.slice(-MAX_STDERR_BUFFER)
      }
      const lines = chunk.split("\n")
      for (const line of lines) {
        if (PROGRESS_REGEX.test(line)) {
          const frameMatch = line.match(FRAME_REGEX)
          const fpsMatch = line.match(FPS_REGEX)
          const timeMatch = line.match(TIME_REGEX)

          if (frameMatch) {
            lastFrames = parseInt(frameMatch[1], 10)
            hasStartedEncoding = true
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

    child.on("close", (code, signal) => {
      clearInterval(startupCheck)
      clearTimeout(overallTimeout)
      cleanupFontconfig()
      console.log(`[encoder] jobId=${job.id} — FFmpeg closed — exitCode=${code}, signal=${signal}, frames=${lastFrames}, fps=${lastFps}`)
      if (code !== 0 && !killedByAbort) {
        const stderrTail = stderrBuffer ? stderrBuffer.slice(-4000) : ""
        if (stderrTail) {
          console.error(`[encoder] jobId=${job.id} — FFmpeg stderr (last 4000 chars):\n${stderrTail}`)
        }
      }
      const errorDetail = killedByAbort
        ? "FFmpeg was aborted (job cancelled)"
        : killedByTimeout
          ? "FFmpeg was killed due to timeout"
          : signal === "SIGKILL"
            ? "FFmpeg was killed by the system (likely out of memory)"
            : code !== 0
              ? `FFmpeg exited with code ${code}`
              : null
      resolve({
        exitCode: code,
        signal: signal,
        error: errorDetail,
        stderr: stderrBuffer,
        killedByTimeout,
        killedByAbort,
      })
    })

    child.on("error", (err) => {
      clearInterval(startupCheck)
      clearTimeout(overallTimeout)
      cleanupFontconfig()
      console.error(`[encoder] jobId=${job.id} — FFmpeg spawn error: ${err.message}`)
      resolve({
        exitCode: null,
        signal: null,
        error: err.message,
        stderr: stderrBuffer,
        killedByTimeout: false,
        killedByAbort: false,
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