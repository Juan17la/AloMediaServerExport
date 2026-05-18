export type EncodingPreset = "fast" | "medium" | "slow"

export type ExportVideoCodec = "h264" | "vp9" | "av1"

export type ExportOutputFormat = "mp4" | "mov" | "mkv" | "avi"

export type JobStatus =
  | "pending"
  | "probing"
  | "planning"
  | "encoding"
  | "merging"
  | "finalizing"
  | "done"
  | "failed"
  | "cancelled"

export interface OutputTarget {
  format: ExportOutputFormat
  codec: ExportVideoCodec
  resolution: { width: number; height: number }
  fps: number
  videoBitrate: number | null
  crf: number
  preset: string
  tune: string | null
  audioCodec: string
  audioBitrate: number
  container: string
  pixelFormat: string
}

export interface MediaProbeResult {
  mediaId: string
  fileHash: string
  codec: string
  width: number
  height: number
  fps: number
  duration: number
  isVfr: boolean
  pixelFormat: string | null
  audioCodec: string | null
  audioSampleRate: number | null
  audioChannels: number | null
  audioBitrate: number | null
  fileExtension: string
}

export interface TextStyle {
  fontSize: number
  fontFamily: string
  color: string
  backgroundColor?: string
  textAlign: "left" | "center" | "right"
  opacity: number
  bold: boolean
  italic: boolean
}

export interface RenderSegment {
  id: string
  clipId: string
  mediaId: string
  mediaStart: number
  mediaEnd: number
  timelineStart: number
  timelineEnd: number
  speed: number
  type: "video" | "audio" | "image" | "text"
  trackId: string
  trackOrder: number
  trackType: "video" | "audio"
  transform: { x: number; y: number; width: number; height: number; rotation: number } | null
  colorAdjustments: {
    brightness: number
    contrast: number
    saturation: number
    gamma: number
    exposure: number
    shadow?: number
    definition?: number
  } | null
  audioConfig: {
    volume: number
    muted: boolean
    fadeInDuration: number
    fadeOutDuration: number
    balance: number
  } | null
  volume: number | null
  content?: string
  style?: TextStyle
}

export interface RenderTransition {
  transitionId: string
  trackId: string
  clipARef: { clipId: string } | { synthetic: "black_silence" }
  clipBRef: { clipId: string } | { synthetic: "black_silence" }
  startTimeS: number
  endTimeS: number
  durationS: number
  boundaryTimeS: number
  typeCanonical: string
  audioCurveType: "equal_power"
}

export interface StreamCopySegment {
  mediaId: string
  mediaStart: number
  mediaEnd: number
  timelineStart: number
  timelineEnd: number
  codec: string
}

export interface RenderPlan {
  id: string
  createdAt: number
  projectDuration: number
  outputTarget: OutputTarget
  segments: RenderSegment[]
  transitions: RenderTransition[]
  probeResults: MediaProbeResult[]
  canStreamCopy: boolean
  streamCopySegments: StreamCopySegment[]
  estimatedTotalFrames: number
  mediaFileNames: Record<string, string>
}

export interface ExportJob {
  id: string
  plan: RenderPlan | null
  status: JobStatus
  progress: number
  framesProcessed: number
  framesTotal: number
  startedAt: number | null
  completedAt: number | null
  error: string | null
  outputFilePath: string | null
  engine: "native"
  createdAt: number
}

export interface FilterGraphResult {
  filterComplex: string
  inputArgs: string[]
  outputArgs: string[]
  mappingArgs: string[]
  estimatedFrames: number
  inputIndexByMediaId: Map<string, number>
  hasAudioOutput: boolean
}

export interface GpuCapabilities {
  nvenc: boolean
  qsv: boolean
  vaapi: boolean
  selectedEncoder: string
  selectedCodec: string
}