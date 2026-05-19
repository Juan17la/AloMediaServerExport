const isWindows = process.platform === "win32"

const DEFAULT_FONT_DIR = isWindows ? "C:/Windows/Fonts" : "/usr/share/fonts/truetype"

const SYSTEM_FONTS: Record<string, string> = isWindows
  ? {
      "inter": "Inter.ttf",
      "arial": "arial.ttf",
      "arial black": "ariblk.ttf",
      "helvetica": "arial.ttf",
      "verdana": "verdana.ttf",
      "trebuchet ms": "trebuc.ttf",
      "impact": "impact.ttf",
      "times new roman": "times.ttf",
      "georgia": "georgia.ttf",
      "courier new": "cour.ttf",
    }
  : {
      "inter": "Inter.ttf",
      "arial": "Arial.ttf",
      "helvetica": "Helvetica.ttf",
      "verdana": "Verdana.ttf",
      "trebuchet ms": "Trebuchet_MS.ttf",
      "impact": "Impact.ttf",
      "times new roman": "Times_New_Roman.ttf",
      "georgia": "Georgia.ttf",
      "courier new": "Courier_New.ttf",
    }

export const config = {
  port: parseInt(process.env.PORT ?? "3001", 10),
  enableGpu: process.env.ENABLE_GPU === "true",
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS ?? "2", 10),
  maxSegmentWorkers: parseInt(process.env.MAX_SEGMENT_WORKERS ?? "4", 10),
  jobTimeoutMs: parseInt(process.env.JOB_TIMEOUT_MS ?? "1800000", 10),
  cleanupAgeMs: parseInt(process.env.CLEANUP_AGE_MS ?? "3600000", 10),
  tempDir: process.env.TEMP_DIR ?? "./tmp",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:4173,https://alo-media.vercel.app").split(","),
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
  fontDir: process.env.FONT_DIR ?? DEFAULT_FONT_DIR,
  systemFonts: SYSTEM_FONTS,
}