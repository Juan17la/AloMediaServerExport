import { config } from "../config.js"
import { mkdir, readdir, stat, unlink, rm } from "node:fs/promises"
import { join } from "node:path"

export async function ensureTempDir(): Promise<void> {
  await mkdir(config.tempDir, { recursive: true })
  await mkdir(join(config.tempDir, "assets"), { recursive: true })
  await mkdir(join(config.tempDir, "outputs"), { recursive: true })
  await mkdir(join(config.tempDir, "uploads"), { recursive: true })
}

export function getOutputPath(jobId: string, format: string): string {
  return join(config.tempDir, "outputs", `${jobId}.${format}`)
}

export async function cleanupOldFiles(): Promise<number> {
  const now = Date.now()
  let cleaned = 0

  for (const subdir of ["assets", "outputs", "uploads"]) {
    const dir = join(config.tempDir, subdir)
    try {
      const entries = await readdir(dir)
      for (const entry of entries) {
        const filePath = join(dir, entry)
        const stats = await stat(filePath)
        if (now - stats.mtimeMs > config.cleanupAgeMs) {
          await unlink(filePath)
          cleaned++
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }

  return cleaned
}

export async function cleanupJobFiles(jobId: string): Promise<void> {
  for (const subdir of ["assets", "outputs", "uploads"]) {
    const dir = join(config.tempDir, subdir)
    try {
      const entries = await readdir(dir)
      for (const entry of entries) {
        if (entry.startsWith(`job_${jobId}`) || entry.includes(jobId)) {
          await unlink(join(dir, entry)).catch(() => {})
        }
      }
    } catch {
      // Ignore errors
    }
  }

  // Clean up segment/text directories
  const segmentsDir = join(config.tempDir, `job_${jobId}`)
  try {
    await rm(segmentsDir, { recursive: true, force: true })
  } catch {
    // Ignore errors
  }
}