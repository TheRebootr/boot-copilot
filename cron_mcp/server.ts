#!/usr/bin/env bun
/**
 * Cron Jobs MCP Server — register_cron_job tool.
 *
 * When Claude calls register_cron_job(), this server validates the input
 * and writes a confirmation request file. The Telegram bot picks it up,
 * shows confirm/reject buttons, and the user's tap triggers the actual
 * registry write (deterministic, no LLM in the write path).
 *
 * Uses the official MCP TypeScript SDK for proper protocol compliance.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const VALID_TYPES = ["reminder", "claude"] as const;
const VALID_REPEATS = [
  "half-hourly",
  "hourly",
  "daily",
  "weekly",
  "monthly",
] as const;
const MAX_PAYLOAD_LENGTH = 2000;

// Regex for due_in: number + unit (m = minutes, h = hours, d = days)
const DUE_IN_REGEX = /^(\d+)\s*(m|h|d)$/;

/**
 * Resolve a relative duration string to an absolute ISO 8601 datetime.
 * Uses the server's clock (TZ=Asia/Singapore in container).
 */
function resolveDueIn(dueIn: string): string {
  const match = dueIn.trim().match(DUE_IN_REGEX);
  if (!match) {
    throw new Error(
      `Invalid due_in format: '${dueIn}'. Use <number><unit> where unit is m (minutes), h (hours), or d (days). Examples: '5m', '2h', '1d'.`
    );
  }

  const amount = parseInt(match[1]!, 10);
  const unit = match[2]!;

  if (amount <= 0) {
    throw new Error("due_in amount must be positive");
  }

  let ms: number;
  switch (unit) {
    case "m":
      ms = amount * 60_000;
      break;
    case "h":
      ms = amount * 3_600_000;
      break;
    case "d":
      ms = amount * 86_400_000;
      break;
    default:
      throw new Error(`Unknown unit: ${unit}`);
  }

  const target = new Date(Date.now() + ms);

  // Format as ISO 8601 with SGT offset (+08:00)
  const pad = (n: number) => String(n).padStart(2, "0");
  // Compute SGT components (UTC+8)
  const sgtMs = target.getTime() + 8 * 3_600_000;
  const sgt = new Date(sgtMs);

  return (
    `${sgt.getUTCFullYear()}-${pad(sgt.getUTCMonth() + 1)}-${pad(sgt.getUTCDate())}` +
    `T${pad(sgt.getUTCHours())}:${pad(sgt.getUTCMinutes())}:${pad(sgt.getUTCSeconds())}` +
    `+08:00`
  );
}

// Create the MCP server
const server = new Server(
  {
    name: "cron-jobs",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "register_cron_job",
        description:
          "Register a scheduled cron job (reminder or claude check). " +
          "Use due_in for relative times ('5m', '2h', '1d') or due_at for absolute times. " +
          "Provide exactly one of due_in or due_at. " +
          "After calling this tool, STOP and wait — the user will see Confirm/Reject buttons in Telegram. " +
          "Do NOT add any text after calling this tool. Just call and end your turn.",
        inputSchema: {
          type: "object" as const,
          properties: {
            type: {
              type: "string",
              enum: ["reminder", "claude"],
              description:
                "Job type: 'reminder' sends payload directly to Telegram, " +
                "'claude' spawns Claude to evaluate a condition",
            },
            due_in: {
              type: "string",
              description:
                "Relative duration from now. Format: <number><unit> where unit is m (minutes), h (hours), or d (days). " +
                "Examples: '5m', '2h', '1d'. Use this for relative requests like 'in 10 minutes'. " +
                "Mutually exclusive with due_at.",
            },
            due_at: {
              type: "string",
              description:
                "Absolute ISO 8601 datetime with timezone offset, e.g. '2026-03-05T09:00:00+08:00'. " +
                "Use SGT (+08:00). Use this for absolute requests like 'at 3pm tomorrow'. " +
                "Mutually exclusive with due_in.",
            },
            payload: {
              type: "string",
              description:
                "For reminders: the message text. For claude: the condition/prompt to evaluate. " +
                "Plain text only, no emojis (they are stripped automatically).",
            },
            repeat: {
              type: "string",
              enum: ["half-hourly", "hourly", "daily", "weekly", "monthly"],
              description:
                "Repeat schedule. Omit or null for one-time jobs.",
            },
          },
          required: ["type", "payload"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "register_cron_job") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments as {
    type?: string;
    due_in?: string;
    due_at?: string;
    payload?: string;
    repeat?: string | null;
  };

  // --- Validation ---

  // Type
  if (!args.type || !VALID_TYPES.includes(args.type as (typeof VALID_TYPES)[number])) {
    throw new Error(`Invalid type: must be one of ${VALID_TYPES.join(", ")}`);
  }

  // due_in / due_at: exactly one required
  const hasDueIn = typeof args.due_in === "string" && args.due_in.trim().length > 0;
  const hasDueAt = typeof args.due_at === "string" && args.due_at.trim().length > 0;

  if (hasDueIn && hasDueAt) {
    throw new Error("Provide either due_in or due_at, not both");
  }
  if (!hasDueIn && !hasDueAt) {
    throw new Error("Either due_in or due_at is required");
  }

  let resolvedDueAt: string;

  if (hasDueIn) {
    resolvedDueAt = resolveDueIn(args.due_in!);
  } else {
    const dueDate = new Date(args.due_at!);
    if (isNaN(dueDate.getTime())) {
      throw new Error(`Invalid due_at: cannot parse '${args.due_at}'`);
    }
    resolvedDueAt = args.due_at!;
  }

  // Payload — strip emojis (the runner adds type-appropriate prefixes)
  if (!args.payload || args.payload.trim().length === 0) {
    throw new Error("payload is required and cannot be empty");
  }
  args.payload = args.payload.replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "").trim();
  if (args.payload.length === 0) {
    throw new Error("payload is empty after removing emojis");
  }
  if (args.payload.length > MAX_PAYLOAD_LENGTH) {
    throw new Error(
      `payload too long: ${args.payload.length} chars (max ${MAX_PAYLOAD_LENGTH})`
    );
  }

  // Repeat (optional)
  const repeat = args.repeat || null;
  if (
    repeat !== null &&
    !VALID_REPEATS.includes(repeat as (typeof VALID_REPEATS)[number])
  ) {
    throw new Error(
      `Invalid repeat: must be one of ${VALID_REPEATS.join(", ")} or null`
    );
  }

  // --- Write confirmation request file ---
  const requestUuid = crypto.randomUUID().slice(0, 8);
  const chatId = process.env.TELEGRAM_CHAT_ID || "";

  const requestData = {
    request_id: requestUuid,
    type: args.type,
    due_at: resolvedDueAt,
    payload: args.payload,
    repeat: repeat,
    status: "pending",
    chat_id: chatId,
    created_at: new Date().toISOString(),
  };

  const requestFile = `/tmp/cron-confirm-${requestUuid}.json`;
  await Bun.write(requestFile, JSON.stringify(requestData, null, 2));

  return {
    content: [
      {
        type: "text" as const,
        text: "[Confirmation sent to user. STOP HERE — do not output any more text. Wait for user to tap Confirm or Reject.]",
      },
    ],
  };
});

// Run the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Cron Jobs MCP server running on stdio");
}

main().catch(console.error);
