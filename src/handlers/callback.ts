/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration).
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session } from "../session";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { cancelJob, addJob, type Job } from "../jobs";

/**
 * Handle callback queries from inline keyboards.
 */
export async function handleCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  // 2. Handle resume callbacks: resume:{session_id}
  if (callbackData.startsWith("resume:")) {
    await handleResumeCallback(ctx, callbackData);
    return;
  }

  // 3. Handle job callbacks: jobs:cancel|confirm|reject:{id}
  if (callbackData.startsWith("jobs:")) {
    await handleJobCallback(ctx, callbackData);
    return;
  }

  // 4. Parse callback data: askuser:{request_id}:{option_index}
  if (!callbackData.startsWith("askuser:")) {
    await ctx.answerCallbackQuery();
    return;
  }

  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndex = parseInt(parts[2]!, 10);

  // 3. Load request file
  const requestFile = `/tmp/ask-user-${requestId}.json`;
  let requestData: {
    question: string;
    options: string[];
    status: string;
  };

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
    console.error(`Failed to load ask-user request ${requestId}:`, error);
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // 4. Get selected option
  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  // 5. Update the message to show selection
  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch (error) {
    console.debug("Failed to edit callback message:", error);
  }

  // 6. Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // 7. Delete request file
  try {
    unlinkSync(requestFile);
  } catch (error) {
    console.debug("Failed to delete request file:", error);
  }

  // 8. Send the choice to Claude as a message
  const message = selectedOption;

  // Interrupt any running query - button responses are always immediate
  if (session.isRunning) {
    console.log("Interrupting current query for button response");
    await session.stop();
    // Small delay to ensure clean interruption
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(userId, username, "CALLBACK", message, response);
  } catch (error) {
    console.error("Error processing callback:", error);

    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        console.debug("Failed to delete tool message:", error);
      }
    }

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    typing.stop();
  }
}

/**
 * Handle resume session callback (resume:{session_id}).
 */
async function handleResumeCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const sessionId = callbackData.replace("resume:", "");

  if (!sessionId || !userId || !chatId) {
    await ctx.answerCallbackQuery({ text: "ID sessione non valido" });
    return;
  }

  // Check if session is already active
  if (session.isActive) {
    await ctx.answerCallbackQuery({ text: "Sessione già attiva" });
    return;
  }

  // Resume the selected session
  const [success, message] = session.resumeSession(sessionId);

  if (!success) {
    await ctx.answerCallbackQuery({ text: message, show_alert: true });
    return;
  }

  // Update the original message to show selection
  try {
    await ctx.editMessageText(`✅ ${message}`);
  } catch (error) {
    console.debug("Failed to edit resume message:", error);
  }
  await ctx.answerCallbackQuery({ text: "Sessione ripresa!" });

  // Send a hidden recap prompt to Claude
  const recapPrompt =
    "Please write a very concise recap of where we are in this conversation, to refresh my memory. Max 2-3 sentences.";

  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    await session.sendMessageStreaming(
      recapPrompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );
  } catch (error) {
    console.error("Error getting recap:", error);
    // Don't show error to user - session is still resumed, recap just failed
  } finally {
    typing.stop();
  }
}

/**
 * Handle job-related callbacks: cancel, confirm, reject.
 */
async function handleJobCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const parts = callbackData.split(":");
  if (parts.length < 2) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const action = parts[1]!;

  if (action === "dismiss") {
    // Dismiss the job list message
    try {
      await ctx.deleteMessage();
    } catch (error) {
      console.debug("Failed to delete job list message:", error);
    }
    await ctx.answerCallbackQuery();
    return;
  }

  const id = parts[2];
  if (!id) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  if (action === "cancel") {
    // Cancel an existing job from /jobs list
    const success = cancelJob(id);
    if (success) {
      try {
        await ctx.editMessageText(`\u{2705} Job ${id} cancelled.`);
      } catch (error) {
        console.debug("Failed to edit cancel message:", error);
      }
      await ctx.answerCallbackQuery({ text: "Job cancelled" });
    } else {
      await ctx.answerCallbackQuery({
        text: "Job not found or already completed",
        show_alert: true,
      });
    }
    return;
  }

  if (action === "confirm") {
    // Confirm a pending cron job registration
    const requestFile = `/tmp/cron-confirm-${id}.json`;
    let requestData: {
      type: "reminder" | "claude";
      due_at: string;
      payload: string;
      repeat: string | null;
    };

    try {
      const file = Bun.file(requestFile);
      const text = await file.text();
      requestData = JSON.parse(text);
    } catch (error) {
      console.error(`Failed to load cron-confirm request ${id}:`, error);
      await ctx.answerCallbackQuery({
        text: "Request expired or invalid",
        show_alert: true,
      });
      return;
    }

    try {
      const jobId = addJob({
        type: requestData.type,
        due_at: requestData.due_at,
        payload: requestData.payload,
        repeat: (requestData.repeat ?? null) as Job["repeat"],
      });

      try {
        await ctx.editMessageText(
          `\u{2705} Job registered (ID: <code>${jobId}</code>)`,
          { parse_mode: "HTML" }
        );
      } catch (error) {
        console.debug("Failed to edit confirm message:", error);
      }
      await ctx.answerCallbackQuery({ text: "Job registered" });
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: `Failed: ${String(error).slice(0, 100)}`,
        show_alert: true,
      });
      return;
    }

    // Clean up request file
    try {
      unlinkSync(requestFile);
    } catch (error) {
      console.debug("Failed to delete cron-confirm file:", error);
    }

    // Resume Claude's event loop with confirmation
    if (session.isRunning) {
      // Session is paused waiting for user response - no need to send a new message
      // The confirm result will be picked up on the next query
    }
    return;
  }

  if (action === "reject") {
    // Reject a pending cron job registration
    try {
      await ctx.editMessageText("\u{274C} Job rejected.");
    } catch (error) {
      console.debug("Failed to edit reject message:", error);
    }
    await ctx.answerCallbackQuery({ text: "Job rejected" });

    // Clean up request file
    const requestFile = `/tmp/cron-confirm-${id}.json`;
    try {
      unlinkSync(requestFile);
    } catch (error) {
      console.debug("Failed to delete cron-confirm file:", error);
    }
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}
