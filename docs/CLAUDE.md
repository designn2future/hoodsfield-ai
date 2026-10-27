# Connecting Claude

Hoodsfield uses Claude in exactly one place: the **Assistant** (idea in, finished video out) and the agent/MCP integration. Everything else (images, video, the Scene Composer, the Timeline, upscaling, the H3 prompt coach) runs locally with no account.

## How it works

The Assistant starts a headless **Claude Code** session (`claude -p`) on your PC. The session can only use Hoodsfield's own tools (through `assistant_mcp.py`) and read files. It cannot run commands or edit files. It asks you for approval at the key points of a project, and you can watch it from your phone.

Because it is *your* Claude Code, there are two ways to sign in:

| Method | Best for | Cost |
|---|---|---|
| **Your Claude account** (default) | Anyone with a Claude Pro/Max plan | Counts against your plan, no key on this PC |
| **Anthropic API key** | People with an Anthropic Console account and no subscription | Pay-as-you-go on your API account |

## Connect, step by step

Open **Settings → Claude**. The card shows one of three states:

1. **Claude Code is not installed.** Copy the command shown (`npm install -g @anthropic-ai/claude-code`, or the PowerShell one-liner if you do not use Node), run it in a terminal, then click **Check again**. Official instructions: <https://docs.claude.com/en/docs/claude-code/setup>.
2. **Installed, but not signed in.** Click **Sign in with your Claude account**. A terminal window opens and your browser asks you to approve. Hoodsfield notices when you are done.
3. **Connected as …** Click **Test the connection** once. It sends one tiny request and reports the answer time.

Choose the model in the same card: **Opus** is the most capable, **Sonnet** is faster and lighter on your plan.

### Using an API key instead

In *How Hoodsfield signs in to Claude* choose `api_key`, paste the key, and save. The key is stored in `app/backend/hoodsfield_settings.json` on this PC (that file is git-ignored) and is passed to Claude Code only when the Assistant runs. Use **Remove** to delete it.

### No Claude at all

Pick **Lite (local)** in the Assistant. It uses a local Ollama model (default `qwen2.5:14b-instruct`) with a fixed pipeline. Scripts are plainer and there is no self-review, but it is free and needs no account.

## What the Assistant can and cannot do

- Can: write the script, call Hoodsfield's generation, edit and timeline tools, read the pictures it made, ask you questions.
- Cannot: run shell commands, edit files, browse the web, or use any tool that is not Hoodsfield's.
- Output goes to `Desktop\Hoodsfield_Output` (change it in Settings → Storage).

## Settings that matter

| Setting | Where | Default |
|---|---|---|
| Sign-in method | Settings → Claude | your account |
| Model | Settings → Claude | opus |
| Claude Code location | Settings → Claude → Advanced | found automatically |
| Output folder | Settings → ComfyUI & folders → Storage | Desktop/Hoodsfield_Output |

## Troubleshooting

| Symptom | Fix |
|---|---|
| The card says *not installed* but you installed it | Open a new terminal and run `claude --version`. If that works, restart Hoodsfield so it sees the new PATH, or set the path under Advanced. |
| *Not signed in* after you signed in | Click **Check again**. If it persists run `claude auth status` in a terminal. |
| The test fails with a usage or rate-limit message | Your plan's limit was reached; wait, or switch the model to Sonnet. |
| Sign-in window does nothing | Run `claude auth login` yourself in a terminal; Hoodsfield picks it up on the next check. |
| You are on your phone | Signing in, folders and passwords can only be changed on the PC itself, on purpose. |

To sign out: **Settings → Claude → Sign out**.
