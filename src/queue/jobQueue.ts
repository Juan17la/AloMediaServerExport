import type { ExportJob } from "../types.js"
import { v4 as uuidv4 } from "uuid"

export type JobPriority = "low" | "normal" | "high"

interface QueueEntry {
  job: ExportJob
  priority: JobPriority
  resolve: (job: ExportJob) => void
  reject: (error: Error) => void
}

export class JobQueue {
  private queue: QueueEntry[] = []
  private activeJobs: Map<string, ExportJob> = new Map()
  private maxConcurrent: number
  private processing = false

  constructor(maxConcurrent: number = 2) {
    this.maxConcurrent = maxConcurrent
  }

  enqueue(job: ExportJob, priority: JobPriority = "normal"): Promise<ExportJob> {
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = { job, priority, resolve, reject }
      const priorityOrder: Record<JobPriority, number> = { high: 0, normal: 1, low: 2 }

      const insertIndex = this.queue.findIndex(
        (e) => priorityOrder[priority] < priorityOrder[e.priority],
      )
      if (insertIndex === -1) {
        this.queue.push(entry)
      } else {
        this.queue.splice(insertIndex, 0, entry)
      }

      this.processQueue()
    })
  }

  getJob(jobId: string): ExportJob | undefined {
    return this.activeJobs.get(jobId) ?? this.queue.find((e) => e.job.id === jobId)?.job
  }

  removeJob(jobId: string): boolean {
    const index = this.queue.findIndex((e) => e.job.id === jobId)
    if (index !== -1) {
      this.queue.splice(index, 1)
      return true
    }
    return this.activeJobs.delete(jobId)
  }

  getQueueLength(): number {
    return this.queue.length
  }

  getActiveCount(): number {
    return this.activeJobs.size
  }

  updateJob(jobId: string, updates: Partial<ExportJob>): ExportJob | null {
    const activeJob = this.activeJobs.get(jobId)
    if (activeJob) {
      Object.assign(activeJob, updates)
      return activeJob
    }

    const entry = this.queue.find((e) => e.job.id === jobId)
    if (entry) {
      Object.assign(entry.job, updates)
      return entry.job
    }

    return null
  }

  markActive(jobId: string): void {
    const entry = this.queue.find((e) => e.job.id === jobId)
    if (entry) {
      this.activeJobs.set(jobId, entry.job)
      this.queue = this.queue.filter((e) => e.job.id !== jobId)
    }
  }

  markCompleted(jobId: string): void {
    this.activeJobs.delete(jobId)
    this.processQueue()
  }

  private processQueue(): void {
    if (this.processing) return
    if (this.activeJobs.size >= this.maxConcurrent) return
    if (this.queue.length === 0) return

    this.processing = true
    const entry = this.queue.shift()
    if (entry) {
      this.activeJobs.set(entry.job.id, entry.job)
      entry.resolve(entry.job)
    }
    this.processing = false

    if (this.queue.length > 0 && this.activeJobs.size < this.maxConcurrent) {
      this.processQueue()
    }
  }
}

export function createJobId(): string {
  return uuidv4()
}