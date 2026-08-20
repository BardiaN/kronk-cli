# kronk-cli

A Claude-Code-style terminal agent for local models served by
[Kronk](https://github.com/ardanlabs/kronk). Reads your files, runs your commands, writes code —
entirely on your machine. No network, no API key, no per-token cost.

```
› refactor the SSE parser in src/client.js to handle multi-line data fields

  ┄ thinking ┄
  The parser splits on newlines and only handles `data: ` prefixes…
  ┄─────────┄

  1 ⚙ read src/client.js
  ✓ 118 lines
  2 ⚙ write src/client.js
    + export async function* streamChat({ model, messages, tools, signal }) {
    …42 more lines
  approve write_file? [y/N] y
  ✓ 1 lines

  Done — the parser now buffers continuation lines before dispatching.
  2104→812 tok · 61.3 tok/s · ttft 240ms · 1980 cached
```

[![ci](https://github.com/BardiaN/kronk-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/BardiaN/kronk-cli/actions/workflows/ci.yml)
[![security](https://github.com/BardiaN/kronk-cli/actions/workflows/security.yml/badge.svg)](https://github.com/BardiaN/kronk-cli/actions/workflows/security.yml)
[![codeql](https://github.com/BardiaN/kronk-cli/actions/workflows/codeql.yml/badge.svg)](https://github.com/BardiaN/kronk-cli/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/BardiaN/kronk-cli/badge)](https://scorecard.dev/viewer/?uri=github.com/BardiaN/kronk-cli)
[![npm](https://img.shields.io/npm/v/kronk-cli?logo=npm)](https://www.npmjs.com/package/kronk-cli)

**Zero dependencies.** It is `fetch` and `readline` against Kronk's OpenAI-compatible API.

**It talks to your Kronk server and nothing else** — enforced in CI by running the whole thing
inside a network namespace with only loopback. See [Verifying this build](#verifying-this-build).

---

## Verifying this build

This tool reads your files and runs your commands. You should not have to take anyone's word for
what it does with them — so every claim here is machine-checkable.

### Check the artifact came from this source

Every release tarball carries a signed attestation binding it to the repository, commit and
workflow run that produced it:

```bash
gh attestation verify kronk-cli-*.tgz --repo BardiaN/kronk-cli
```

npm packages carry the same provenance, shown as a **Provenance** panel on the
[package page](https://www.npmjs.com/package/kronk-cli), and verifiable locally:

```bash
npm audit signatures
```

Both fail if the artifact was built anywhere other than this repository's CI.

### Read the scan results yourself

| | |
|---|---|
| [Security tab](https://github.com/BardiaN/kronk-cli/security/code-scanning) | every CodeQL and Scorecard finding, open and closed |
| [Scorecard report](https://scorecard.dev/viewer/?uri=github.com/BardiaN/kronk-cli) | per-check supply-chain scores, updated weekly |
| [Actions](https://github.com/BardiaN/kronk-cli/actions/workflows/security.yml) | full logs of every scan, including the egress proof |

These are published by GitHub and the OpenSSF, not by this project. Nobody here can edit them.

### Check it does not phone home

The strongest claim, and the easiest to test yourself:

```bash
# Linux — run it with no network except loopback
sudo unshare --net bash -c 'ip link set lo up; kronk-cli --models'
```

CI runs exactly this on every pull request against a stub server, and a second step proves the
namespace was really isolated so a pass cannot be a false negative.

Or just read `src/` — it is under 1,500 lines with no dependencies, and every network call goes
through one function in `src/client.js`.

---

## Requirements

- Node 20+
- A running Kronk server with at least one chat model

```bash
kronk model pull unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M
kronk server start --detach
```

---

## Install

### From source — recommended while you're editing it

```bash
git clone https://github.com/you/kronk-cli && cd kronk-cli
npm link
```

`npm link` symlinks the repo into your global `bin`, so `kronk-cli` works from any directory
**and your edits take effect immediately**:

```console
$ which kronk-cli
/Users/you/.nvm/versions/node/v24.13.0/bin/kronk-cli

$ ls -l $(which kronk-cli)
… -> ../lib/node_modules/kronk-cli/src/index.js
```

### Uninstall

```bash
npm unlink -g kronk-cli        # removes the global symlink
npm unlink                     # run inside the repo, clears the local link
```

Verify it's gone with `which kronk-cli` — no output means success.

### Other ways

```bash
npm install -g kronk-cli       # from the registry
npm install -g .               # from source, COPIES — you must redo it after every edit
npx kronk-cli                  # no install
node src/index.js              # no install, from the repo
```

### Using nvm?

Global bins live **inside the active Node version**, so switching versions hides the command.

```bash
nvm alias default v24.13.0     # pin, and stay on it
npm link                       # …or re-link under each version you use
```

To make it survive version switches entirely, skip npm and symlink somewhere neutral:

```bash
ln -s "$PWD/src/index.js" ~/.local/bin/kronk-cli
```

### Scope

The agent roots itself at **the directory you launch it from**. `cd` into a project first.

Two separate things keep it there, and they are worth telling apart:

| | Enforced by | Covers |
|---|---|---|
| **Path containment** | `kronk-cli` | `read_file`, `write_file`, `list_dir`, `search` — resolved through symlinks, so a link inside the project cannot point out of it |
| **Shell confinement** | the kernel — `sandbox-exec` on macOS, [`bwrap`](https://github.com/containers/bubblewrap) on Linux | `bash`: writes outside the project are denied, and key material (`~/.ssh`, `~/.gnupg`, `~/.password-store`, the macOS keychain, `~/.netrc`, `~/.npmrc`) is unreadable |

The startup banner says which is in force:

```
  sandbox  paths + seatbelt
```

If no backend is available, it says so rather than implying one:

```
  sandbox  paths only — bwrap not installed, shell commands are unconfined
```

**What shell confinement does not do.** Reads stay open outside the deny-list, because denying them
wholesale breaks every compiler and runtime the agent needs. The network is not blocked — the agent
has to be able to run `npm install`. So it stops a command from *writing* outside your project or
reading your keys; it does not make a hostile command harmless.

The write half is categorical: both backends start from "nothing is writable" and hand back the
project, the temp directories and the build caches. The read half is a deny-list, and a deny-list is
only as good as its entries — which is exactly why it is kept narrow rather than broad. See
[Authenticated CLIs](#authenticated-clis) for the trade that produced it.

Two more limits worth stating:

- **Symlinks out of the project are refused, even benign ones.** An `npm link`ed package under
  `node_modules` resolves outside the root, so `read_file` and `write_file` will decline it. Use the
  real path, which is inside a project the agent was launched in.
- **Only filesystem operations are constrained.** The macOS profile allows everything else by
  design, so a command that persuades an *already-running* unsandboxed process to act on its behalf
  is not covered by it. Confinement limits what a command reaches directly; it is not a substitute
  for reading the command before approving it.

`KRONK_SANDBOX=strict` refuses to run `bash` at all when no backend is available, which is the
setting to use if you need the guarantee rather than the best effort. `KRONK_SANDBOX=off` disables
confinement.

On Linux, install bubblewrap to get it: `apt install bubblewrap` / `dnf install bubblewrap`.

### Authenticated CLIs

**Tools you are already logged in to keep working.** `kubectl`, `argocd`, `aws`, `docker` and the
like read their session tokens from `~/.kube`, `~/.config/argocd`, `~/.aws` and so on, and those
stay readable:

```console
› run lint on all apps, then show me the current kube context
  1 ⚙ bash: npx nx run-many -t lint
  ✓ 174 lines
  2 ⚙ bash: kubectl config current-context
  ✓ prod
```

An earlier version of this denied those directories too. It broke `kubectl` and `gh` outright while
still missing `argocd`, whose token lives in `~/.config/argocd` and which nobody had thought to add
— a deny-list that blocks the tools you use and misses the ones you forgot costs real work and buys
little, since an attacker just takes whichever store was not on the list. So the default covers
material that is pivot-grade and never legitimately read by a build.

**The one exception is the macOS keychain**, which is denied by default. `gh` stores its token
there, so it will report `Failed to log in` under the sandbox. If you want it:

```bash
KRONK_SANDBOX_ALLOW=~/Library/Keychains kronk-cli
```

**Logging in from inside the agent will not work**, by design — `argocd login`, `gh auth login` and
`kubectl config set-context` all write outside the project. Log in yourself, in your own shell,
before starting a session. If a tool genuinely must write to its config directory, allow just that:

```bash
KRONK_SANDBOX_ALLOW=~/.config/argocd kronk-cli
```

`KRONK_SANDBOX_ALLOW` makes a path fully available — writable, and readable even if it is denied by
default. `KRONK_SANDBOX_DENY` goes the other way and hides more, if you would rather the agent could
not read your cluster credentials at all:

```bash
KRONK_SANDBOX_DENY=~/.kube,~/.aws kronk-cli     # kubectl and aws will now fail
```

Both take a comma- or colon-separated list, and `~` expands.

> ⚠️ `bwrap` needs unprivileged user namespaces, which several hardened distros and most CI
> runners disable — GitHub's included. Where they are off, `bwrap` is installed but cannot start,
> and the banner will say the shell is unconfined. That is why the backend is probed rather than
> assumed, and why the check is worth reading rather than trusting the presence of the binary.

---

## Project awareness

On startup `kronk-cli` scans the directory once and puts a primer in the system prompt, so the
model knows where it is before it calls a single tool:

- working directory and platform
- git branch, uncommitted files, last 5 commits
- top-level layout (skipping `node_modules`, `dist`, `.git`, …)
- the contents of the first **agent file** it finds:
  `AGENTS.md`, `CLAUDE.md`, `KRONK.md`, `.cursorrules`, `CONVENTIONS.md`

The REPL confirms what it picked up:

```console
$ kronk-cli

  ██ kronk-cli  · local agent, no network
  model  unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT
  server http://localhost:11435/v1

  context  ~/Projects/api · git · AGENTS.md
```

Which means this needs no tools at all:

```console
$ kronk-cli "what branch am I on and what indentation does this project use?"

  - Branch: main, 1 uncommitted file (src/more.js)
  - Indentation: tabs, never spaces — per AGENTS.md
```

An `AGENTS.md` is the way to give the model standing instructions. It is read on every run, so
conventions stick without you restating them:

```markdown
# Project conventions

- This project uses tabs, never spaces.
- Every exported function needs a JSDoc block.
- Never add dependencies without asking.
```

The primer costs roughly 150–800 tokens and sits at the front of the system message, so Kronk's
prompt cache reuses it across every turn. Disable it with `--no-context`.

> It is a **primer, not a preload** — the model still reads files with `read_file` when it needs
> their contents. Nothing beyond the listing and the agent file is sent up front.

---

## Usage

```bash
kronk-cli                                   # interactive REPL
kronk-cli "explain src/agent.js"            # one shot, prints and exits
git diff | kronk-cli "review this diff"     # stdin as extra context
git log --oneline -20 | kronk-cli           # stdin as the whole prompt
kronk-cli --auto "make the tests pass"      # unattended, runs the whole task
```

---

## Command-line options

| Flag | Default | |
|---|---|---|
| `-m`, `--model <id>` | `unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT` | Model to use. A substring is enough; `/AGENT` profiles win ties |
| `-l`, `--models`, `--list` | — | List the models Kronk is serving, then exit |
| `--no-context` | off | Skip the startup scan of the working directory |
| `--no-compact` | off | Never auto-compact; fail when the window fills instead |
| `--mcp [names]` | off | Attach MCP servers — bare for all, or a comma list |
| `--mcp-list` | — | Show configured MCP servers and their tools, then exit |
| `-a`, `--auto` | off | Autonomous: auto-approve tools **and** run until the task is done. Implies `--yes` |
| `-y`, `--yes` | off | Auto-approve `write_file` and `bash` without the autonomous prompt |
| `--no-think` | off | Disable the model's reasoning pass server-side. Much faster |
| `--steps <n>` | unlimited | Cap tool calls per task. `0`, `off`, `none`, `inf`, `unlimited` all mean no cap |
| `-h`, `--help` | — | Print all options and exit |

Anything not consumed as a flag becomes the prompt. With both an inline prompt and piped stdin,
the two are concatenated.

`Ctrl-C` aborts the in-flight response and the tool loop without killing the session.

---

## The status line

Above every prompt, reflecting current state rather than what you launched with:

```
⏵ AGENT · auto · no-think · mcp nx,kronk · steps 50 · 22k/131k 17% ▓▓░░░░░░░░
›
```

Model, active modes, attached MCP servers, any step cap, and the context meter — grey under 70%,
yellow past 70%, red past 90%. Toggling `/auto`, `/think` or `/steps` updates it immediately.

The per-turn usage line still prints after each response; this one is the running picture.

---

## REPL commands

| Command | |
|---|---|
| `/help` | list these commands |
| `/models` | what Kronk is serving, with sizes and what is resident |
| `/model <id>` | switch model — substring match, `/AGENT` preferred |
| `/file <path>` | add a file to the conversation as context |
| `/auto` | toggle autonomous mode (auto-approve + run to completion) |
| `/steps [n\|off]` | show or set the tool-call cap |
| `/thinking` | show or hide the model's reasoning |
| `/think` | turn reasoning off entirely — much faster |
| `/mcp` | list attached MCP servers and their tools |
| `/context` | how much of the context window is used |
| `/compact` | replace the conversation with a summary of itself |
| `/clear` | reset the conversation, keep the model |
| `/exit`, `/quit` | quit |

---

## Environment variables

| Variable | Default | |
|---|---|---|
| `KRONK_URL` | `http://localhost:11435/v1` | Kronk API base |
| `KRONK_TOKEN` | `kronk` | Any non-empty value while Kronk runs open; a real JWT when protected |
| `KRONK_MODEL` | `unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT` | Model id |
| `KRONK_MAX_TOKENS` | `8192` | Output cap per response |
| `KRONK_MAX_STEPS` | unlimited | Cap on tool calls per task |
| `KRONK_THINKING` | `true` | `false` hides reasoning but still generates it |
| `KRONK_NO_THINK` | — | `1` disables reasoning server-side |
| `KRONK_TOOL_TIMEOUT` | `900` | Seconds before a shell command is killed |
| `KRONK_SANDBOX` | `auto` | `auto` confines `bash` when the OS can, `strict` refuses to run it when it cannot, `off` disables it |
| `KRONK_SANDBOX_ALLOW` | — | Paths to make fully available inside the sandbox, comma or colon separated |
| `KRONK_SANDBOX_DENY` | — | Extra paths to hide from `bash`, comma or colon separated |
| `KRONK_DISTILL` | `true` | `false` disables tool-output distillation |
| `KRONK_DISTILL_AT` | `8000` | Characters of output that trigger distillation |
| `KRONK_AUTO_COMPACT` | `true` | `false` disables automatic compaction |
| `KRONK_COMPACT_AT` | `0.85` | Fraction of the window that triggers compaction |
| `NO_COLOR` | — | Any value disables colour |

### Config file

`~/.kronk-cli.json`. Command line beats environment beats this file.

```json
{
  "baseUrl": "http://localhost:11435/v1",
  "token": "kronk",
  "model": "unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT",
  "maxTokens": 16384,
  "maxSteps": 200,
  "showThinking": false,
  "autoCompact": true,
  "compactAt": 0.85,
  "noThink": true
}
```

---

## Choosing a model

Resolution order:

1. `-m` / `--model`
2. `KRONK_MODEL`, or `model` in `~/.kronk-cli.json`
3. `unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT`, if Kronk is serving it
4. otherwise the largest chat model available, preferring an `/AGENT` profile

A substring is enough — `-m Qwen3.6` resolves to the full id. An unrecognised value warns and
falls back rather than failing.

### Listing models

```console
$ kronk-cli --models

  ○ unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M        22.1 GB · vision
  ● unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT  22.1 GB · vision · loaded 28.1 GB

  resident: 28.1 GB
  default:  unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT
  select:   kronk-cli -m <substring>
```

`●` is the model you will get. `loaded` means it is resident in Kronk's pool, and how much
memory it holds.

> ⚠️ Profiles share one file **on disk** but are **separate resident copies in RAM**. Asking for
> the base id while `/AGENT` is loaded pulls a second 22 GB instance. Pick one and stay on it.
> Free a stray one with:
> ```bash
> curl -X POST localhost:11435/v1/kronk/models/unload \
>   -H 'Content-Type: application/json' -d '{"id":"<model-id>"}'
> ```

### Tip: use an `/AGENT` profile

Kronk lets one GGUF serve several runtime configurations. Add this to
`~/.kronk/models/model_config.yaml` and restart the server:

```yaml
version: 1
models:
  unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT:
    context-window: 131072
    nseq-max: 2
    sampling-parameters:
      temperature: 0.6
      top_k: 20
      top_p: 0.95
```

---

## Context window

Kronk reports the **effective** window for whichever model id you selected — that comes from
`context-window` in `model_config.yaml`, so a `/AGENT` profile and its base model can differ.

Three places surface it:

**The banner**

```
  context  ~/Projects/api · git · AGENTS.md · 131k ctx
```

**Every usage line**, as a meter that fills as the conversation grows:

```
  18471→57 tok · 69.0 tok/s · ttft 397ms · 18260 cached   18k/131k 14% ▓░░░░░░░░░
```

Grey under 70%, yellow past 70%, red past 90%.

**`/context`**, on demand:

```console
› /context
  3.8k/131k 3% ░░░░░░░░░░
  window: 131,072 tokens · model supports up to 262,144
  messages: 2
```

`model supports up to` is the model's trained maximum from its GGUF metadata. If it exceeds your
configured window, you can raise `context-window` in `~/.kronk/models/model_config.yaml` — at the
cost of KV-cache memory.

### The model knows its own budget

The startup primer tells it, so you can plan work against the number without stating it:

> Your context window is 131,072 tokens, shared by everything in this conversation: these
> instructions, file contents you read, command output, and your own replies. When you plan work
> that must fit in one context, size it against that number and say what you assumed.

```console
$ kronk-cli "how many tokens is your context window?"
  131,072 tokens
```

That makes prompts like *"break this refactor into tickets, each sized to fit one context"*
resolve against a real number instead of a guess.

> ⚠️ It knows the **window**, not the live fill level — no model can see its own usage mid-turn.
> The meter is for you. If you need it to plan against remaining space, tell it what `/context`
> reports.

### What happens at 100%

Kronk **rejects the request** — no silent truncation, no sliding window:

```
400  input tokens [40021] exceed context window [32768]
```

Because history only grows, every later turn would fail the same way. So `kronk-cli` compacts.

### Compaction

**`/compact`** replaces the conversation with a summary of itself, keeping the system message and
the project primer:

```console
› /compact
  compacted 18,412 → 1,204 tokens (−93%)
```

The summary is written for the model, not for you — goal, decisions made **and rejected**, files
touched and what they now do, commands run and what they showed, what is outstanding.

**Automatic**, in two situations:

| Trigger | |
|---|---|
| Past `KRONK_COMPACT_AT` of the window (default **85%**) | compacts between turns |
| A `400 … exceed context window` | compacts and **retries the same turn once** |

```console
  context full — compacting and retrying
  transcript too large for one pass — elided 92,415 chars from the middle
  compacted 38,102 → 143 tokens (−100%)
```

Disable with `--no-compact` or `KRONK_AUTO_COMPACT=false` if you would rather see the failure.

**Details worth knowing**

- Tool messages are **dropped**, not carried over — they are only valid beside the assistant
  `tool_calls` that produced them, and a partial carry leaves orphaned `tool_call_id`s that the
  API rejects. The summary is what survives.
- The summarizer runs against the same window that just overflowed, so an oversized transcript is
  first trimmed from the **middle** — the goal sits at the start, current state at the end.
- If a summary comes out no shorter than the original, the conversation is left alone.
- **Compaction is lossy.** Anything the summary omits is gone. `/context` before a long run, and
  `/clear` when you switch tasks, both beat relying on it.

---

## Tools

| Tool | Approval | |
|---|---|---|
| `read_file` | — | Read a UTF-8 file |
| `list_dir` | — | List a directory |
| `search` | — | Regex search via ripgrep, falling back to grep |
| `write_file` | ✋ | Create or overwrite; shows a diff preview first |
| `bash` | ✋ | Run a command; shows it first |

`--yes` and `--auto` skip the prompts. Paths resolve against the session directory and cannot
escape the launch root — including through a symlink. `bash` additionally runs under an OS
sandbox where one is available; see [Scope](#scope) for exactly what that covers. `bash` keeps its working directory **between calls**, so a bare `cd`
sticks the way it would in a real shell.

---

## MCP servers

`kronk-cli` is an MCP **client**. It speaks both transports — stdio for local servers, Streamable
HTTP for remote ones — with no extra dependency.

Off by default. Attach with `--mcp`:

```bash
kronk-cli --mcp                  # everything configured
kronk-cli --mcp nx,kronk         # just these
kronk-cli --mcp-list             # what is configured, what connects, what it exposes
```

```console
$ kronk-cli --mcp nx "what does 'nx affected' do?"
  mcp      nx(1) · 1 tools
  1 ⚙ nx__nx_docs {"userQuery":"what does 'nx affected' do"}
  ✓ 44 lines
  `nx affected` identifies projects changed by a PR and runs tasks only on those…
```

Tools are namespaced `server__tool` so they cannot collide with the built-ins, and `/mcp` lists
what is attached.

### Where to put the config

Four files are read, later ones winning on name collision:

| File | Scope | |
|---|---|---|
| `~/.claude.json` | user | Claude Code's global `mcpServers`, reused as-is |
| `~/.claude.json` → `projects[cwd].mcpServers` | user, per-project | |
| **`./.mcp.json`** | **project** | **committed to the repo** |
| `~/.kronk-cli.json` | user | `mcpServers` key |
| `./.kronk-cli.json` | project | `mcpServers` key |

**Best practice: put project tooling in `./.mcp.json` and commit it.** A teammate cloning the
repo gets the same servers with no setup, and the config is versioned with the code that needs it.
Keep account-level services that carry your credentials — Jira, GitLab, cloud providers — in
`~/.claude.json` so they follow you between projects and never land in a repo.

```jsonc
// .mcp.json — commit this
{
  "mcpServers": {
    "nx":       { "type": "stdio", "command": "npx", "args": ["-y", "nx-mcp@latest"] },
    "kronk":    { "type": "http",  "url": "http://localhost:9000/mcp" },
    "postgres": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "DATABASE_URL": "postgres://localhost/dev" }
    }
  }
}
```

Add `"disabled": true` to any entry to keep it in the file but out of the session.

### Approval

MCP tools are third-party code, so anything whose name looks like a write — `create`, `update`,
`delete`, `apply`, `sync`, `run`, `deploy`, … — prompts before it runs. Read-only lookups do not,
because a prompt you always accept is not a safety control. `--yes` and `--auto` bypass both.

### Keep the tool count down

Every attached tool goes into the request, and a local model's tool selection degrades well before
a frontier model's does. `--mcp` with everything configured can easily mean 35+ tools; `kronk-cli`
warns past 25. Name the two or three servers a task actually needs.

A server that fails to start is reported and skipped — the rest still work. Servers needing OAuth
(Atlassian, GitLab) return `401` here, since `kronk-cli` has no browser auth flow.

---

## Long-running commands

**While it runs**, a live line redraws in place — elapsed time, lines produced, and the last line
printed, so a ten-minute build shows movement instead of looking like a hang:

```
  3 ⚙ bash: npx nx run-many -t lint
    ⠹ 84s · 12,403 lines · →7.5k ctx 6% capped   [42/97] Linting @acme/api…
```

`→7.5k ctx 6%` is what this command will cost your context once it finishes — not what it has
printed. `capped` means it has already produced more than will be kept, so the number has stopped
climbing and the excess is being discarded rather than silently eating your window.

**Timeout** is 15 minutes (`KRONK_TOOL_TIMEOUT`, in seconds), not the 2 minutes that used to kill
real builds. The command runs in its own process group, so a timeout kills the whole tree rather
than leaving orphans holding the pipe open.

**When it fails**, you get the reason, the duration, the directory, and whatever it printed
before dying:

```
  ✗ error: exit code 1 after 184.2s
    cwd: /Users/you/Projects/api
    stderr:
    src/api/handlers.ts:142:11 - TS2345: Argument of type 'string' is not assignable…
```

or, on a timeout:

```
  ✗ error: killed after 900.0s (timeout 900s).
    The command may simply be slow — re-run a narrower scope, or raise KRONK_TOOL_TIMEOUT.
    stdout:
    [42/97] Linting @acme/api…
```

---

## Do tool calls cost tokens?

**Yes — the output does.** Every tool result is appended to the conversation as a `tool` message
and re-sent with each subsequent turn. The command itself is a few dozen tokens; a build log can
be tens of thousands. One `nx run-many` on a large monorepo can take more than half a context
window on its own.

### Distillation

So large results are summarized **in a separate model call whose context is thrown away**. Only
the digest reaches your conversation — the raw log never enters it.

```
  3 ⚙ bash: ./build.sh
    distilled 9,988 → 2,153 tokens (separate context)
  ✓ 80 lines
```

The digest is structured and deliberately blunt:

```
STATUS: failed — 14 of 217 tests failed, 400 packages built
FAILURES: src/api/handlers.ts:142:11 - TS2345: Argument of type 'string' is not assignable…
          src/api/handlers.ts:207:3 - TS2554: Expected 2 arguments, but got 1.
NOTES:
```

Before the model sees anything, error and warning lines are extracted from the raw text **by
regex**, and those go into the digest verbatim and marked authoritative. A summarizer reading ten
thousand tokens of build chatter can miss three error lines at the end — mine did, and confidently
reported `FAILURES: none`. Grep is not clever, but it does not overlook things.

The last 2,000 characters of raw output are appended untouched as well, since the tail is usually
the failure itself.

Output longer than 30,000 characters is trimmed **from the middle**, never the end — build tools
put their errors last.

| Setting | Default | |
|---|---|---|
| `KRONK_DISTILL` | `true` | `false` keeps every result whole |
| `KRONK_DISTILL_AT` | `8000` | Result size in characters that triggers it |

### What if a command outputs more than the context window?

It cannot reach your conversation. Output passes three bounds before it becomes a message:

```
  command prints 4.2 MB
        │
        ▼  capture cap — keep the last 400 KB          (MAX_CAPTURE)
      400 KB
        │
        ▼  trim the middle, keep head + tail            (MAX_OUT, 30 KB ≈ 7.5k tokens)
       30 KB
        │
        ▼  distil in a throwaway context                (KRONK_DISTILL_AT)
      ~750 tokens  ──▶ your conversation
```

Every stage keeps the **end** of the output, because that is where build tools report failures,
and error lines are pulled out by regex before any of it is summarized. So the worst case for a
single command is roughly 7.5k tokens with distillation off, or under 1k with it on — never more,
however much the command prints.

The live meter shows you which stage you are in: the projection climbs, then reads `capped` once
the command has outrun what will be kept.


It applies to any tool result, not just `bash` — a large `search` or MCP response is treated the
same way.

> The distiller runs on the same model, so it costs a little time and output tokens. What it buys
> is that those tokens are spent **once** in a throwaway context, instead of sitting in your
> window and being re-sent on every turn for the rest of the session.

---

## Autonomous mode

`--auto`, or `/auto` in the REPL, swaps in a system prompt that tells the model to finish the
whole task — write code, **run** it, read the failure, fix it — and never claim success it has
not executed. Tools are auto-approved and the run continues as long as the task needs.

```console
$ kronk-cli --auto "write a CSV stats script, add a node:test, run it, fix what breaks"

  1 ⚙ ls .
  2 ⚙ read data.csv
  3 ⚙ write stats.js
  4 ⚙ write test.js
  5 ⚙ bash: node --test
  ✓ 10 lines

  Test passes. stats.js auto-detects numeric columns and skips non-numeric values.
```

`Ctrl-C` stops it. Add `--steps N` for unattended runs where nobody is watching.

> ⚠️ `--auto` runs shell commands without asking. Use it where `git checkout` can save you.

---

## How it works

```
  REPL ──▶ messages[] ──▶ POST /v1/chat/completions (stream:true)
   ▲                            │
   │                            ▼
   │                   SSE ──▶ text / reasoning / tool_calls
   │                            │
   │                            ▼
   └──── tool results ◀──── approval ──▶ execute
```

The loop repeats while the model requests tools, so one prompt can read files, run commands, and
write code before answering. Kronk's incremental message cache means each turn re-uses the
previous prompt prefix — watch `cached` climb in the usage line.

| File | |
|---|---|
| `src/index.js` | argv, REPL, one-shot mode |
| `src/agent.js` | the tool loop and system prompts |
| `src/client.js` | SSE streaming and Kronk endpoints |
| `src/tools.js` | tool definitions, sandbox, shell session |
| `src/context.js` | startup scan: git, layout, `AGENTS.md` |
| `src/compact.js` | summarizing the conversation when the window fills |
| `src/mcp.js` | MCP client: stdio + HTTP transports, tool routing |
| `src/distill.js` | summarizing large tool output in a throwaway context |
| `src/config.js` | precedence of flags, env, config file |
| `src/ui.js` | colour, spinner, usage formatting |

---

## Troubleshooting

| Symptom | |
|---|---|
| `Cannot reach Kronk` | `kronk server start --detach` |
| `Kronk is running but has no models` | `kronk model pull <id>` |
| First response takes ~25 s | Cold model load. Keep it warm with `--pool-ttl 1h` on the server |
| Long silence before text | The model is reasoning. `--no-think`, or `/thinking` to watch it |
| `(model produced no answer)` | Reasoning consumed the whole budget. Raise `KRONK_MAX_TOKENS` or use `--no-think` |
| `kronk-cli: command not found` after an nvm switch | Re-run `npm link`, or see [Using nvm?](#using-nvm) |
| Memory climbing | Two profiles resident at once. `kronk-cli --models` to confirm |
| Meter turning red | It self-compacts at 85%. `/compact` sooner, `/clear` to reset, or raise `context-window` in `model_config.yaml` |
| An MCP server shows `401` | It needs OAuth; `kronk-cli` has no browser flow. Use a token-based server config instead |
| A build times out | Raise `KRONK_TOOL_TIMEOUT` (seconds), or narrow the command's scope |
| A command's failure went unnoticed | Should not happen — exit status is captured before the cwd marker runs. Check `✗ error: exit code N` appeared |
| Context vanishing after one command | Its output is large. Distillation is on by default — check `KRONK_DISTILL_AT` |
| Model picks the wrong tool | Too many attached. Narrow with `--mcp <names>` |
| One message alone exceeds the window | Compaction cannot help — nothing survives trimming a single oversized input. Split the file, or raise `context-window` |
| Model ignores your conventions | Put them in `AGENTS.md` at the project root, and check the `context` line names it |
| Slow start in a huge repo | `--no-context` skips the scan |

---

## License

MIT
