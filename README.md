# Boot

Boot is RALY's reference AI assistant — a TypeScript/Bun Telegram bot that runs Claude Code
inside a Docker container. You talk to it via Telegram; it runs tools, reads files, and
manages sessions on your behalf.

## Features

- **Text** — ask questions, give instructions, have conversations
- **Voice** — speak naturally; transcribed via OpenAI, processed by Claude
- **Photos** — send screenshots or documents for visual analysis
- **Documents** — PDFs, text files, and archives (ZIP, TAR) extracted and analyzed
- **Audio** — audio files transcribed via OpenAI and processed
- **Video** — video messages and video notes processed by Claude
- **Sessions** — conversations persist across messages; resume previous sessions
- **Message queuing** — send multiple messages while Claude works; prefix with `!` to interrupt
- **Extended thinking** — trigger reasoning with keywords like "think" or "ultrathink"
- **Interactive buttons** — Claude presents options as tappable inline buttons via `ask_user` MCP tool
- **MCP servers** — extend Claude's capabilities with custom tools

## Running Boot

Boot runs inside RALY's Docker container. From the host:

```bash
cd ~/BootDrive
docker compose build
docker compose up -d
```

For development (inside the container or with Bun installed):

```bash
bun install
bun run src/index.ts
```

## Configuration

Copy `.env.example` to `.env` and fill in your values.

### Required

| Variable                 | Description                                         |
| ------------------------ | --------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`     | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs                   |

### Recommended

| Variable             | Default    | Description                                    |
| -------------------- | ---------- | ---------------------------------------------- |
| `CLAUDE_WORKING_DIR` | `$HOME`    | Working directory (e.g. `/workspace/projects`) |
| `OPENAI_API_KEY`     | —          | OpenAI key for voice transcription             |
| `AUDIT_LOG_PATH`     | `/tmp/...` | Recommended: `/data/logs/audit.log`            |

### Optional

| Variable                 | Default                            | Description                                              |
| ------------------------ | ---------------------------------- | -------------------------------------------------------- |
| `CLAUDE_MODEL`           | `claude-sonnet-4-6`                | Claude model to use                                      |
| `ALLOWED_PATHS`          | `/workspace`, `/data`, `~/.claude` | Comma-separated allowed directories (overrides defaults) |
| `ANTHROPIC_API_KEY`      | —                                  | API key (alternative to CLI auth)                        |
| `THINKING_KEYWORDS`      | `think,pensa,ragiona`              | Keywords that trigger extended thinking                  |
| `THINKING_DEEP_KEYWORDS` | `ultrathink,think hard,pensa bene` | Keywords for deep thinking (50k tokens)                  |
| `RATE_LIMIT_ENABLED`     | `true`                             | Enable rate limiting                                     |
| `RATE_LIMIT_REQUESTS`    | `20`                               | Max requests per window                                  |
| `RATE_LIMIT_WINDOW`      | `60`                               | Rate limit window in seconds                             |

### Container Paths

| Path                | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `/workspace`        | Project files (bind-mounted from `~/BootDrive/workspace`) |
| `/data`             | Persistent state — sessions, config, credentials, logs    |
| `/tmp/telegram-bot` | Scratch files (not persistent)                            |

### MCP Servers

```bash
cp mcp-config.ts mcp-config.local.ts
# Edit with your MCP servers
```

Boot includes a built-in `ask_user` MCP server for interactive buttons. Add your own
servers for additional tools.

### Claude Authentication

| Method                     | Best For           | Setup                             |
| -------------------------- | ------------------ | --------------------------------- |
| **CLI Auth** (recommended) | Subscription users | `claude /login` inside container  |
| **API Key**                | Pay-per-token      | Set `ANTHROPIC_API_KEY` in `.env` |

## Commands

| Command    | Description                         |
| ---------- | ----------------------------------- |
| `/start`   | Show status and your user ID        |
| `/new`     | Start a fresh session               |
| `/resume`  | Pick from recent sessions to resume |
| `/stop`    | Interrupt current query             |
| `/status`  | Check what Claude is doing          |
| `/restart` | Restart the bot                     |

## Security

Boot runs with all Claude Code permission prompts bypassed — Claude can read, write, and
execute commands without confirmation within allowed paths. This is intentional for a
seamless Telegram experience.

Protections:

1. **User allowlist** — only configured Telegram IDs can use the bot
2. **Container isolation** — Boot runs inside a Docker container; `/workspace` and `/data` are the accepted blast radius
3. **Path validation** — file access restricted to `ALLOWED_PATHS`
4. **Command safety** — destructive patterns (fork bombs, `rm -rf /`, etc.) are blocked
5. **Rate limiting** — prevents runaway usage
6. **Audit logging** — all interactions logged

See `SECURITY.md` for the full security model.

## References

- Forked from [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) (MIT)
- Part of [RALY](https://github.com/therebootr/raly) — Run Assistants Locally Yourself
