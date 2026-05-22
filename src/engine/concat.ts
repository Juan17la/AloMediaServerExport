import { config } from "../config.js"
import { spawn } from "node:child_process"
import { copyFile, writeFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

export async function concatenateSegments(
  segmentFiles: string[],
  outputFile: string,
): Promise<void> {
  if (segmentFiles.length === 0) {
    throw new Error("No segment files to concatenate")
  }

  // Resolve files to absolute paths to avoid ffmpeg resolving them relative to the concat file
  const resolvedFiles = segmentFiles.map((f) => resolve(f))

  // Verify all segment files exist and collect missing files for diagnostics
  const missing: string[] = []
  for (const f of resolvedFiles) {
    try {
      await stat(f)
    } catch {
      missing.push(f)
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing segment files: ${missing.join(", ")}`)
  }

  if (resolvedFiles.length === 1) {
    await copyFile(resolvedFiles[0], outputFile)
    return
  }

  const concatListPath = join(config.tempDir, `concat_${Date.now()}.txt`)
  const concatContent = resolvedFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n")
  await writeFile(concatListPath, concatContent)

  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      outputFile,
    ]

    const child = spawn(config.ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stderr = ""
    const MAX_STDERR = 10_000
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString()
      if (stderr.length > MAX_STDERR) {
        stderr = stderr.slice(-MAX_STDERR)
      }
    })

    const cleanupConcatList = () => {
      import("node:fs").then((fs) => fs.promises.unlink(concatListPath).catch(() => {}))
    }

    child.on("close", (code) => {
      cleanupConcatList()
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Concat failed with code ${code}: ${stderr.slice(-500)}`))
      }
    })

    child.on("error", (err) => {
      cleanupConcatList()
      reject(err)
    })
  })
}

export async function remuxToFormat(
  inputFile: string,
  outputFile: string,
  format: string,
): Promise<void> {
  const args: string[] = [
    "-y",
    "-nostdin",
    "-i", inputFile,
    "-c", "copy",
  ]

  if (format === "mp4" || format === "mov") {
    args.push("-movflags", "+faststart")
  }

  args.push(outputFile)

  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stderr = ""
    const MAX_STDERR = 10_000
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString()
      if (stderr.length > MAX_STDERR) {
        stderr = stderr.slice(-MAX_STDERR)
      }
    })

    child.on("close", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Remux failed with code ${code}: ${stderr.slice(-500)}`))
      }
    })

    child.on("error", (err) => {
      reject(err)
    })
  })
}