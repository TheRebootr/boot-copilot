/**
 * Shared registry I/O for cron jobs.
 *
 * Used by command handlers (/jobs), callback handlers (confirm/cancel),
 * and the MCP server (addJob). All writes are atomic (temp + rename).
 */

import { readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";

const REGISTRY = "/data/jobs/registry.json";
const REGISTRY_DIR = "/data/jobs";
const MAX_PENDING_JOBS = 50;

export interface Job {
  id: string;
  type: "reminder" | "claude";
  created_at: string;
  due_at: string;
  payload: string;
  repeat: "half-hourly" | "hourly" | "daily" | "weekly" | "monthly" | null;
  status: "pending" | "done" | "failed";
  error_count: number;
}

/**
 * Read the job registry. Returns [] on missing or corrupt file.
 */
export function readRegistry(): Job[] {
  try {
    const raw = readFileSync(REGISTRY, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

/**
 * Write registry atomically (temp file + rename).
 */
function writeRegistryAtomic(jobs: Job[]): void {
  const tmpFile = join(REGISTRY_DIR, `.registry.${Date.now()}.tmp`);
  writeFileSync(tmpFile, JSON.stringify(jobs, null, 2) + "\n");
  renameSync(tmpFile, REGISTRY);
}

/**
 * Get pending jobs, sorted by due_at ascending.
 */
export function getPendingJobs(): Job[] {
  return readRegistry()
    .filter((j) => j.status === "pending")
    .sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
}

/**
 * Cancel a job by setting its status to "done". Returns true if found.
 */
export function cancelJob(jobId: string): boolean {
  const jobs = readRegistry();
  const job = jobs.find((j) => j.id === jobId);
  if (!job || job.status !== "pending") return false;

  job.status = "done";
  writeRegistryAtomic(jobs);
  return true;
}

/**
 * Add a new job to the registry. Validates pending cap.
 * Returns the generated job ID.
 */
export function addJob(params: {
  type: "reminder" | "claude";
  due_at: string;
  payload: string;
  repeat: Job["repeat"];
}): string {
  const jobs = readRegistry();

  // Check pending cap
  const pendingCount = jobs.filter((j) => j.status === "pending").length;
  if (pendingCount >= MAX_PENDING_JOBS) {
    throw new Error(`Too many pending jobs (max ${MAX_PENDING_JOBS})`);
  }

  const id = crypto.randomUUID().slice(0, 8);
  const newJob: Job = {
    id,
    type: params.type,
    created_at: new Date().toISOString(),
    due_at: params.due_at,
    payload: params.payload,
    repeat: params.repeat,
    status: "pending",
    error_count: 0,
  };

  jobs.push(newJob);
  writeRegistryAtomic(jobs);
  return id;
}

/**
 * Format a job for Telegram display (HTML).
 */
export function formatJobForDisplay(job: Job): string {
  const typeEmoji = job.type === "reminder" ? "\u{1F514}" : "\u{1F916}";
  const repeatLabel = job.repeat ? ` (${job.repeat})` : " (once)";

  // Format due_at in SGT
  const due = new Date(job.due_at);
  const dateStr = due.toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // Truncate payload for preview
  const preview =
    job.payload.length > 80 ? job.payload.slice(0, 77) + "..." : job.payload;

  return (
    `${typeEmoji} <b>${job.type}</b>${repeatLabel}\n` +
    `    ${dateStr}\n` +
    `    <i>${escapeHtml(preview)}</i>`
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
