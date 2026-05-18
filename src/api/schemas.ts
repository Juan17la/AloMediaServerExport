import { z } from "zod"

// Note: zod is an optional dependency; if not installed, this file provides
// the schema definitions for reference. The actual validation in routes.ts
// uses basic type checks. Install zod for full schema validation.

export const outputTargetSchema = z.object({
  format: z.enum(["mp4", "mov", "mkv", "avi"]),
  codec: z.enum(["h264", "vp9", "av1"]),
  resolution: z.object({
    width: z.number().int().min(1).max(7680),
    height: z.number().int().min(1).max(4320),
  }),
  fps: z.number().int().min(1).max(240),
  videoBitrate: z.number().nullable(),
  crf: z.number().int().min(0).max(51),
  preset: z.string(),
  tune: z.string().nullable(),
  audioCodec: z.string(),
  audioBitrate: z.number().int().min(0),
  container: z.string(),
  pixelFormat: z.string(),
})

export const renderSegmentSchema = z.object({
  id: z.string(),
  clipId: z.string(),
  mediaId: z.string(),
  mediaStart: z.number().min(0),
  mediaEnd: z.number().min(0),
  timelineStart: z.number().min(0),
  timelineEnd: z.number().min(0),
  speed: z.number().min(0.01),
  type: z.enum(["video", "audio", "image", "text"]),
  trackId: z.string(),
  trackOrder: z.number(),
  trackType: z.enum(["video", "audio"]),
  transform: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    rotation: z.number(),
  }).nullable(),
  colorAdjustments: z.any().nullable(),
  audioConfig: z.any().nullable(),
  volume: z.number().nullable(),
})

export const renderPlanSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  projectDuration: z.number().min(0),
  outputTarget: outputTargetSchema,
  segments: z.array(renderSegmentSchema),
  transitions: z.array(z.any()),
  probeResults: z.array(z.any()),
  canStreamCopy: z.boolean(),
  streamCopySegments: z.array(z.any()),
  estimatedTotalFrames: z.number().int().min(0),
  mediaFileNames: z.record(z.string()),
})