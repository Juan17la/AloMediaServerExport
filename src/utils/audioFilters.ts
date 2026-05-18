export interface AudioConfig {
  volume: number
  muted: boolean
  fadeInDuration: number
  fadeOutDuration: number
  balance: number
}

export function buildVolumeFilter(config: AudioConfig): string | null {
  if (config.muted) return "volume=0"
  if (Math.abs(config.volume - 1.0) > 0.001) return `volume=${config.volume}`
  return null
}

export function buildFadeFilter(config: AudioConfig, clipDuration: number): string | null {
  let fadeIn = config.fadeInDuration
  let fadeOut = config.fadeOutDuration
  if (fadeIn === 0 && fadeOut === 0) return null

  const total = fadeIn + fadeOut
  if (total > clipDuration) {
    const scale = clipDuration / total
    fadeIn = fadeIn * scale
    fadeOut = fadeOut * scale
  }

  const parts: string[] = []
  if (fadeIn > 0) {
    parts.push(`afade=t=in:st=0:d=${fadeIn}`)
  }
  if (fadeOut > 0) {
    parts.push(`afade=t=out:st=${clipDuration - fadeOut}:d=${fadeOut}`)
  }
  return parts.join(",")
}

export function buildBalanceFilter(config: AudioConfig): string | null {
  if (Math.abs(config.balance) <= 0.001) return null

  const b = config.balance
  if (Math.abs(b - -1.0) <= 0.001) return "pan=stereo|c0=c0|c1=c0"
  if (Math.abs(b - 1.0) <= 0.001) return "pan=stereo|c0=c1|c1=c1"

  const leftWeight = 1 - Math.max(0, b)
  const rightWeight = 1 - Math.max(0, -b)
  return `pan=stereo|c0=${leftWeight}*c0|c1=${rightWeight}*c1`
}

export function buildFullAudioFilterChain(config: AudioConfig, clipDuration: number): string | null {
  const parts = [
    buildVolumeFilter(config),
    buildFadeFilter(config, clipDuration),
    buildBalanceFilter(config),
  ].filter((p): p is string => p !== null)

  return parts.length > 0 ? parts.join(",") : null
}