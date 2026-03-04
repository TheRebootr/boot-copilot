/**
 * Session title inference using Claude Haiku via CLI.
 *
 * Generates concise 4-7 word titles from the first user message + Claude reply.
 * Uses `claude --print` (same pattern as cron runner) — no extra SDK dependency.
 */

/**
 * Infer a short session title from the first exchange.
 * Returns a 4-7 word title, or null on failure.
 */
export async function inferSessionTitle(
  userMessage: string,
  claudeReply: string,
): Promise<string | null> {
  // Truncate inputs to save tokens
  const userTrunc = userMessage.slice(0, 500);
  const replyTrunc = claudeReply.slice(0, 500);

  const prompt =
    "Generate a concise 4-7 word title for this conversation. " +
    "Return ONLY the title, no quotes or punctuation.\n\n" +
    `User: ${userTrunc}\n\nAssistant: ${replyTrunc}`;

  try {
    const proc = Bun.spawn(
      ["claude", "--print", "--model", "claude-haiku-4-5-20251001", "--max-tokens", "30", prompt],
      { stdout: "pipe", stderr: "pipe" },
    );

    // 15s timeout
    const timeout = setTimeout(() => proc.kill(), 15_000);
    const output = await new Response(proc.stdout).text();
    clearTimeout(timeout);

    const title = output.trim().replace(/^["']|["']$/g, "");
    return title || null;
  } catch (error) {
    console.warn("Title inference failed:", error);
    return null;
  }
}
