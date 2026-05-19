import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas"
import type { RenderSegment } from "../types.js"
import { config } from "../config.js"
import { join } from "node:path"
import { writeFile, mkdir } from "node:fs/promises"

const CANVAS_W = 1280
const CANVAS_H = 720
const LINE_HEIGHT_RATIO = 1.25

function resolveFontFamily(fontFamily: string): string {
  const normalized = fontFamily.toLowerCase().replace(/['"]/g, "").split(",")[0].trim()
  const mapped = config.systemFonts[normalized]
  if (mapped) {
    const fontPath = join(config.fontDir, mapped).replace(/\\/g, "/")
    GlobalFonts.registerFromPath(fontPath, normalized)
    return normalized
  }
  for (const [key, file] of Object.entries(config.systemFonts)) {
    if (normalized.includes(key)) {
      const fontPath = join(config.fontDir, file).replace(/\\/g, "/")
      GlobalFonts.registerFromPath(fontPath, key)
      return key
    }
  }
  const arialPath = join(config.fontDir, "arial.ttf").replace(/\\/g, "/")
  GlobalFonts.registerFromPath(arialPath, "arial")
  return "arial"
}

function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const paragraphs = text.split("\n")
  const allLines: string[] = []

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      allLines.push("")
      continue
    }

    const words = paragraph.split(/\s+/)
    let currentLine = ""

    for (const word of words) {
      if (currentLine.length === 0) {
        currentLine = word
        continue
      }

      const testLine = `${currentLine} ${word}`
      const metrics = ctx.measureText(testLine)

      if (metrics.width > maxWidth && currentLine.length > 0) {
        if (ctx.measureText(word).width > maxWidth) {
          allLines.push(currentLine)
          let brokenWord = ""
          for (const ch of word) {
            const testBroken = brokenWord + ch
            if (ctx.measureText(testBroken).width > maxWidth && brokenWord.length > 0) {
              allLines.push(brokenWord)
              brokenWord = ch
            } else {
              brokenWord = testBroken
            }
          }
          currentLine = brokenWord
        } else {
          allLines.push(currentLine)
          currentLine = word
        }
      } else {
        currentLine = testLine
      }
    }

    if (currentLine.length > 0) {
      allLines.push(currentLine)
    }
  }

  return allLines
}

export async function renderTextSegmentToPng(
  seg: RenderSegment,
  outputWidth: number,
  outputHeight: number,
): Promise<Buffer> {
  if (seg.type !== "text" || !seg.content || !seg.style || !seg.transform) {
    throw new Error(`Invalid text segment: ${seg.id}`)
  }

  const canvas = createCanvas(outputWidth, outputHeight)
  const ctx = canvas.getContext("2d")

  const scaleX = outputWidth / CANVAS_W
  const scaleY = outputHeight / CANVAS_H

  const s = seg.style
  const t = seg.transform

  const fontSize = s.fontSize * Math.min(scaleX, scaleY)
  const fontFamily = resolveFontFamily(s.fontFamily ?? "Inter, sans-serif")
  const fontWeight = s.bold ? "bold" : "normal"
  const fontStyle = s.italic ? "italic" : "normal"

  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px "${fontFamily}"`
  ctx.textBaseline = "top"

  const px = t.x * scaleX
  const py = t.y * scaleY
  const sw = t.width * scaleX
  const sh = t.height * scaleY

  if (s.backgroundColor) {
    ctx.fillStyle = s.backgroundColor
    ctx.fillRect(px, py, sw, sh)
  }

  ctx.globalAlpha = s.opacity ?? 1
  ctx.fillStyle = s.color ?? "#ffffff"

  const lineHeight = fontSize * (s.lineHeight ?? LINE_HEIGHT_RATIO)
  const lines = wrapText(ctx, seg.content, sw)
  const totalTextHeight = lines.length * lineHeight

  let startY = py + (sh - totalTextHeight) / 2

  if (startY < py) {
    startY = py
  }

  const align = s.textAlign ?? "center"

  for (let i = 0; i < lines.length; i++) {
    const lineY = startY + i * lineHeight
    if (lineY + lineHeight > py + sh + lineHeight * 0.5) break

    let lineX: number
    if (align === "left") {
      ctx.textAlign = "left"
      lineX = px
    } else if (align === "right") {
      ctx.textAlign = "right"
      lineX = px + sw
    } else {
      ctx.textAlign = "center"
      lineX = px + sw / 2
    }

    if (Math.abs(t.rotation) > 0.01) {
      ctx.save()
      ctx.translate(lineX, lineY + lineHeight / 2)
      ctx.rotate((t.rotation * Math.PI) / 180)
      ctx.fillText(lines[i], 0, -lineHeight / 2)
      ctx.restore()
    } else {
      ctx.fillText(lines[i], lineX, lineY)
    }
  }

  const pngData = await canvas.encode("png")
  return Buffer.from(pngData)
}

export async function renderTextSegmentsToFiles(
  segments: RenderSegment[],
  outputWidth: number,
  outputHeight: number,
  tempDir: string,
  jobId: string,
): Promise<Map<string, string>> {
  const textImagePaths = new Map<string, string>()
  const textSegments = segments.filter((s) => s.type === "text" && s.content && s.style && s.transform)

  console.log(`[textRenderer] jobId=${jobId} — Rendering ${textSegments.length} text segments`)

  if (textSegments.length === 0) return textImagePaths

  const textDir = join(tempDir, `job_${jobId}_text`)
  await mkdir(textDir, { recursive: true })

  for (const seg of textSegments) {
    try {
      console.log(`[textRenderer] jobId=${jobId} — Rendering text segment ${seg.id}`)
      const pngBuffer = await renderTextSegmentToPng(seg, outputWidth, outputHeight)
      const fileName = `text_${seg.id}.png`
      const filePath = join(textDir, fileName)
      await writeFile(filePath, pngBuffer)
      textImagePaths.set(seg.id, filePath)
      console.log(`[textRenderer] jobId=${jobId} — Saved text segment ${seg.id} to ${filePath}`)
    } catch (err) {
      console.warn(`[textRenderer] jobId=${jobId} — Failed to render text segment ${seg.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`[textRenderer] jobId=${jobId} — Finished rendering text segments`)
  return textImagePaths
}
