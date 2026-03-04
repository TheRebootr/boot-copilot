/**
 * Session UI helpers for resume command and pagination.
 *
 * Shared between commands.ts (initial display) and callback.ts (pagination).
 */

import type { SavedSession } from "./types";

const PAGE_SIZE = 5;

/**
 * Format an ISO timestamp as a relative time string.
 * Returns: "just now", "2m ago", "3h ago", "yesterday", "4d ago", "2w ago", or "03 Jan" for older.
 */
export function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return "yesterday";
  if (diffDay < 14) return `${diffDay}d ago`;
  if (diffWeek < 8) return `${diffWeek}w ago`;

  // Older: show date
  const d = new Date(iso);
  const day = String(d.getDate()).padStart(2, "0");
  const month = d.toLocaleString("en-US", { month: "short" });
  return `${day} ${month}`;
}

/**
 * Build a paginated session list for inline keyboard display.
 *
 * Returns buttons array (rows of InlineKeyboardButton) and header text.
 */
export function buildSessionPage(
  sessions: SavedSession[],
  page: number,
): {
  buttons: Array<Array<{ text: string; callback_data: string }>>;
  header: string;
} {
  const totalPages = Math.ceil(sessions.length / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, sessions.length);
  const pageItems = sessions.slice(start, end);

  // Header
  const header =
    sessions.length <= PAGE_SIZE
      ? `Saved sessions (${sessions.length})`
      : `Saved sessions (${start + 1}-${end} of ${sessions.length})`;

  // Session buttons
  const buttons: Array<Array<{ text: string; callback_data: string }>> =
    pageItems.map((s) => {
      const timestamp = relativeTime(s.last_activity || s.saved_at);
      // Budget: ~45 chars total for button text. Timestamp takes ~10, separator ~3.
      const titleBudget = 42 - timestamp.length;
      const title =
        s.title.length > titleBudget
          ? s.title.slice(0, titleBudget - 1) + "…"
          : s.title;

      return [
        {
          text: `${timestamp} · ${title}`,
          callback_data: `resume:${s.session_id}`,
        },
      ];
    });

  // Navigation row
  if (totalPages > 1) {
    const navRow: Array<{ text: string; callback_data: string }> = [];

    if (safePage > 0) {
      navRow.push({
        text: "← Newer",
        callback_data: `resume_page:${safePage - 1}`,
      });
    }

    if (safePage < totalPages - 1) {
      navRow.push({
        text: "Older →",
        callback_data: `resume_page:${safePage + 1}`,
      });
    }

    buttons.push(navRow);
  }

  return { buttons, header };
}
