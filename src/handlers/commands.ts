/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { session } from "../session";
import { WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "../config";
import { isAuthorized } from "../security";
import { getPendingJobs, formatJobForDisplay } from "../jobs";
import { buildSessionPage } from "../session-ui";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const status = session.isActive ? "Active session" : "No active session";
  const workDir = WORKING_DIR;

  await ctx.reply(
    `<b>Boot</b> — ${status}\n\n` +
      `<b>Sessions</b>\n` +
      `/new - Start fresh session\n` +
      `/resume - Resume a saved session\n` +
      `/rename - Rename current session\n` +
      `/stop - Stop current query\n` +
      `/retry - Retry last message\n\n` +
      `<b>System</b>\n` +
      `/status - Detailed status\n` +
      `/jobs - Scheduled jobs\n` +
      `/restart - Restart bot\n\n` +
      `<b>Tips</b>\n` +
      `• <code>!</code> prefix to interrupt and send\n` +
      `• "think" for extended reasoning\n` +
      `• Photos, voice, video, docs all supported`,
    { parse_mode: "HTML" }
  );
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Stop any running query
  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      await Bun.sleep(100);
      session.clearStopRequested();
    }
  }

  // Clear session
  await session.kill();

  await ctx.reply("🆕 Session cleared. Next message starts fresh.");
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      // Wait for the abort to be processed, then clear stopRequested so next message can proceed
      await Bun.sleep(100);
      session.clearStopRequested();
    }
    // Silent stop - no message shown
  }
  // If nothing running, also stay silent
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const lines: string[] = [];

  // Session line — title + state in one line
  if (session.isActive) {
    const title = session.conversationTitle || session.sessionId?.slice(0, 8);
    const state = session.isRunning ? "running" : "idle";
    lines.push(`<b>${title}</b> · ${state}`);
  } else {
    lines.push(`No active session`);
  }

  // Running query detail
  if (session.isRunning) {
    const elapsed = session.queryStarted
      ? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
      : 0;
    const tool = session.currentTool || session.lastTool;
    lines.push(tool ? `└ ${tool} (${elapsed}s)` : `└ ${elapsed}s`);
  }

  // Context window — the key info
  const MODEL_CONTEXT_WINDOW = 200_000;
  if (session.lastUsage) {
    const u = session.lastUsage;
    const used = u.input_tokens
      + (u.cache_read_input_tokens || 0)
      + (u.cache_creation_input_tokens || 0);
    const pct = (used / MODEL_CONTEXT_WINDOW) * 100;
    const BAR = 16;
    const fill = Math.round((pct / 100) * BAR);
    const bar = "█".repeat(fill) + "░".repeat(BAR - fill);
    lines.push(
      `\n${bar} ${pct.toFixed(0)}%`,
      `${used.toLocaleString()} / ${MODEL_CONTEXT_WINDOW.toLocaleString()} tokens`,
    );

    // Cache hit ratio — useful to know
    const cached = u.cache_read_input_tokens || 0;
    if (cached > 0) {
      const cacheRatio = ((cached / used) * 100).toFixed(0);
      lines.push(`Cache: ${cacheRatio}% hit`);
    }
  }

  // Error — only if recent
  if (session.lastError) {
    const ago = session.lastErrorTime
      ? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
      : null;
    const ageStr = ago !== null ? ` (${ago}s ago)` : "";
    lines.push(`\n⚠️ ${session.lastError}${ageStr}`);
  }

  const keyboard = new InlineKeyboard().text("✕ Dismiss", "status:dismiss");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

/**
 * /resume - Show list of sessions to resume with inline keyboard.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isActive) {
    await ctx.reply("Session already active. Use /new to start fresh.");
    return;
  }

  // Get saved sessions
  const sessions = session.getSessionList();

  if (sessions.length === 0) {
    await ctx.reply("No saved sessions.");
    return;
  }

  const { buttons, header } = buildSessionPage(sessions, 0);

  await ctx.reply(`<b>${header}</b>`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

/**
 * /jobs - List pending cron jobs with cancel buttons.
 */
export async function handleJobs(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const jobs = getPendingJobs();

  if (jobs.length === 0) {
    await ctx.reply("No pending jobs.");
    return;
  }

  const lines: string[] = [`\u{1F4CB} <b>Pending Jobs</b> (${jobs.length})\n`];

  const keyboard = new InlineKeyboard();

  for (const job of jobs) {
    lines.push(formatJobForDisplay(job));
    lines.push(""); // blank line between jobs

    // Add cancel button for each job
    const label =
      job.payload.length > 20
        ? job.payload.slice(0, 17) + "..."
        : job.payload;
    keyboard
      .text(`\u{274C} Cancel: ${label}`, `jobs:cancel:${job.id}`)
      .row();
  }

  // Dismiss button at the bottom to close the list
  keyboard.text("\u{2716} Dismiss", "jobs:dismiss").row();

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /rename - Rename the current session.
 */
export async function handleRename(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!session.isActive) {
    await ctx.reply("No active session to rename.");
    return;
  }

  // Extract title from command text: /rename My New Title
  const text = ctx.message?.text || "";
  const title = text.replace(/^\/rename\s*/i, "").trim();

  if (!title) {
    await ctx.reply("Usage: /rename <new title>");
    return;
  }

  session.updateTitle(title);
  await ctx.reply(`Session renamed: "${title}"`);
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Check if there's a message to retry
  if (!session.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  if (session.isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  const message = session.lastMessage;
  await ctx.reply(`🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`);

  // Simulate sending the message again by emitting a fake text message event
  // We do this by directly calling the text handler logic
  const { handleText } = await import("./text");

  // Create a modified context with the last message
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      text: message,
    },
  } as Context;

  await handleText(fakeCtx);
}
