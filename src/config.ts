export const config = {
  port: parseInt(process.env.PORT ?? "3001", 10),
  enableGpu: process.env.ENABLE_GPU === "true",
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS ?? "2", 10),
  maxSegmentWorkers: parseInt(process.env.MAX_SEGMENT_WORKERS ?? "4", 10),
  jobTimeoutMs: parseInt(process.env.JOB_TIMEOUT_MS ?? "1800000", 10),
  cleanupAgeMs: parseInt(process.env.CLEANUP_AGE_MS ?? "3600000", 10),
  tempDir: process.env.TEMP_DIR ?? "./tmp",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:4173").split(","),
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
}