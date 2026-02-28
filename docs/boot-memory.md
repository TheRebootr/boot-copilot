# Boot SDK Architecture Reference

How the Claude Code SDK, linuz90/claude-telegram-bot, and Boot's context system actually work together. Written to prevent re-discovery.

Last updated: 2026-02-28

---

## The Three-Layer Context Model

Boot's context is assembled from three independent layers at session start. Each has a different owner, a different purpose, and a different injection mechanism.

### Layer 1: System Prompt (Control Plane)

**Owner:** Bot developer (you, modifying linuz90's code)
**File:** `config.ts` lines 103-122 → `SAFETY_PROMPT`
**Injected by:** `session.ts` line 216 → `systemPrompt: SAFETY_PROMPT`
**Purpose:** Safety rails, path restrictions, destructive-action guards
**Boot can modify:** No. This is code, not a workspace file.

The system prompt is the floor. It defines what Boot cannot do regardless of what CLAUDE.md says. Currently contains: Docker container awareness, file deletion confirmation rules, allowed directory list (`/workspace`, `/data`, `/home/node/.claude`), irreversible-action confirmation requirement.

### Layer 2: CLAUDE.md (Identity Plane)

**Owner:** You (editing `/workspace/CLAUDE.md`)
**Injected by:** SDK via `settingSources: ["user", "project"]` in `session.ts` line 213
**Purpose:** Boot's identity, personality, operating principles, skills, workspace rules
**Boot can modify:** Yes (it's a workspace file), but shouldn't without permission.

The SDK reads CLAUDE.md from the `cwd` directory (`/workspace`) because of the `settingSources` config. This is a convention-based load — the SDK looks for `CLAUDE.md` or `.claude/CLAUDE.md` in the project directory and injects it as project instructions.

### Layer 3: MEMORY.md (Context Plane)

**Owner:** Shared — Boot writes, bot injects
**File:** `/workspace/MEMORY.md`
**Injected by:** `session.ts` — reads MEMORY.md and appends to systemPrompt at session start
**Purpose:** Persistent cross-session facts, decisions, preferences, project state
**Boot can modify:** Yes. CLAUDE.md instructs Boot to update this file.

**Current state:** Implemented. `session.ts` reads `/workspace/MEMORY.md` (if it exists) and appends it to the system prompt under a `## Session Memory` header. Boot sees it alongside the safety rules and CLAUDE.md.

---

## How the Load Chain Works

```
Bot starts → User sends Telegram message
                    ↓
          session.ts creates query()
                    ↓
    ┌───────────────────────────────────┐
    │ SDK query() options:              │
    │                                   │
    │  cwd: "/workspace"                │ ← sets working directory
    │  settingSources: ["user","project"]│ ← loads CLAUDE.md from cwd
    │  systemPrompt: SAFETY_PROMPT      │ ← injects safety rules
    │                                   │
    └───────────────────────────────────┘
                    ↓
    SDK assembles context:
      1. Minimal base system prompt
      2. + SAFETY_PROMPT (from systemPrompt option)
      3. + CLAUDE.md contents (from settingSources)
      4. + user message
                    ↓
    Claude receives all three layers as context
```

**Key insight:** `systemPrompt` and `settingSources` are ADDITIVE, not mutually exclusive. This was verified empirically — the bot has been running both for 2+ weeks successfully.

---

## Memory: Two Separate Systems

### CLI Memory (Interactive SSH sessions)

**Path:** `~/.claude/projects/<encoded-workspace-path>/memory/MEMORY.md`
**Written by:** Claude Code CLI auto-memory system
**Read by:** CLI auto-loads first 200 lines at session start
**Triggered by:** The `claude_code` preset system prompt (which includes auto-memory write instructions)

This only works in interactive CLI sessions because:

- The CLI uses the `claude_code` preset system prompt which includes memory-write instructions
- The bot does NOT use the `claude_code` preset (intentionally — it's developer-workflow-oriented)
- The SDK's auto-memory folder exists but is empty because the write trigger lives in the preset

### Telegram Memory (Bot sessions)

**Path:** `/workspace/MEMORY.md`
**Written by:** Boot, following instructions in CLAUDE.md
**Read by:** `session.ts` reads at session start, appends to systemPrompt
**Triggered by:** User saying "remember X" or Boot deciding to persist important context

These are separate files at separate paths for separate interfaces. This is intentional — what Boot learns during a CLI dev session isn't necessarily what Boot needs during a Telegram conversation.

---

## The Memory Read Patch (IMPLEMENTED)

The write path works: Boot writes to `/workspace/MEMORY.md` per CLAUDE.md instructions.
The read path is now implemented: `session.ts` reads MEMORY.md at each `sendMessageStreaming()` call and appends it to the system prompt.

### Fix: Append to systemPrompt in session.ts

```typescript
import { readFileSync, existsSync } from "fs";
import path from "path";

// Near the query() call in session.ts
const memoryPath = path.join(WORKING_DIR, "MEMORY.md");
const memoryContent = existsSync(memoryPath)
  ? readFileSync(memoryPath, "utf-8")
  : "";

const systemPrompt = memoryContent
  ? `${SAFETY_PROMPT}\n\n## Session Memory\n${memoryContent}`
  : SAFETY_PROMPT;

// Then in query options:
query({
  prompt: userMessage,
  options: {
    cwd: WORKING_DIR,
    settingSources: ["user", "project"],
    systemPrompt: systemPrompt, // was: SAFETY_PROMPT
  },
});
```

**Why this works:** systemPrompt is additive with settingSources. CLAUDE.md still loads via settingSources. The memory content is prepended alongside the safety rules. Boot sees everything.

**Why not use the `claude_code` preset:** The preset is designed for interactive developer workflows — git safety, code review objectivity, professional developer-facing patterns. Boot is a personal assistant, not a pair programmer. The preset would add irrelevant instructions and potential conflicts with CLAUDE.md.

---

## SDK Options Reference (What We Use)

| Option           | Value                                        | Purpose                                                               |
| ---------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| `cwd`            | `/workspace` (from `CLAUDE_WORKING_DIR` env) | Sets working directory for file operations                            |
| `settingSources` | `["user", "project"]`                        | Loads `~/.claude/CLAUDE.md` (user) + `/workspace/CLAUDE.md` (project) |
| `systemPrompt`   | `SAFETY_PROMPT` + MEMORY.md content          | Safety rails + persistent memory context                              |
| `permissionMode` | `bypassPermissions` (implied by bot design)  | No confirmation prompts for file operations                           |

### SDK Options We Deliberately Don't Use

| Option                                                    | Why Not                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `systemPrompt: { type: "preset", preset: "claude_code" }` | Developer-workflow-oriented, irrelevant to personal assistant use case               |
| `settingSources: ["local"]`                               | No local settings needed                                                             |
| `agents`                                                  | Subagents defined in `.claude/agents/` — discovered automatically via settingSources |
| `plugins`                                                 | Not needed yet                                                                       |

---

## File Path Map

```
Host Machine (Mac Mini / Omarchy)
├── /workspace/                          ← CLAUDE_WORKING_DIR
│   ├── CLAUDE.md                        ← Boot's identity (loaded by settingSources)
│   ├── MEMORY.md                        ← Telegram memory (Boot writes, bot reads)
│   ├── .claude/
│   │   ├── agents/                      ← Subagent definitions
│   │   ├── skills/                      ← Skill definitions
│   │   └── commands/                    ← Slash commands
│   ├── notes/                           ← Knowledge base
│   └── ...
│
├── ~/.claude/
│   ├── CLAUDE.md                        ← User-level settings (global, all projects)
│   └── projects/
│       └── <encoded-workspace-path>/
│           └── memory/
│               └── MEMORY.md            ← CLI auto-memory (CLI sessions only)
│
Docker Container
├── /workspace/                          ← Mounted from host (docker volume)
│   └── (same files as host)
└── /home/node/.claude/                  ← Container's .claude dir
```

---

## Extension Points for Future Features

### Adding a New Subagent

1. Create `.claude/agents/<name>.md` with YAML frontmatter
2. The SDK discovers it automatically via `settingSources: ["project"]`
3. Boot delegates per CLAUDE.md instructions

### Adding Cron/Proactive Notifications

1. systemd timer fires on host
2. Timer invokes Claude Code SDK directly (not through the bot)
3. Subagent runs, reasons about whether to notify
4. If actionable, sends Telegram message via bot API
5. Separate from main conversation — own context window

### Adding New Skills

1. Create `.claude/skills/<name>/SKILL.md`
2. SDK discovers via settingSources
3. Add trigger rules to CLAUDE.md so Boot knows when to invoke

### Extending Memory

- v1 (current): Single markdown file, manual read/write
- v2 (future): SQLite + embeddings for semantic search over conversation history
- Reference: godagoo/claude-telegram-relay pattern (swap Supabase for local SQLite)

---

## Decisions and Rationale

| Decision                                             | Rationale                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| No `claude_code` preset                              | Boot is a personal assistant, not a developer tool. The preset adds irrelevant git/coding instructions.            |
| Separate memory files for CLI vs Telegram            | Different interfaces, different contexts. CLI learns dev-session things, Telegram learns life things.              |
| Memory injected via systemPrompt, not prompt prepend | systemPrompt is additive with settingSources. Cleaner separation of concerns.                                      |
| No auto-memory for bot sessions                      | Auto-memory write behavior is in the preset we don't use. Boot writes manually per CLAUDE.md instructions instead. |
| CLAUDE.md as identity, not startup script            | CLAUDE.md is context, not executable. It tells Boot what to do, not how to bootstrap.                              |
