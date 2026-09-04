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

*A real session transcript, kept here to show the UI format. For numbers you can reproduce
yourself on your own hardware, see [Performance](#performance).*

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

The same attestation is attached to every release as a file, so it can be checked without
GitHub's attestations API in the loop — `<tarball>.sigstore.json` for `gh attestation verify`
and cosign, `<tarball>.intoto.jsonl` for SLSA tooling:

```bash
gh release download v0.1.3 --repo BardiaN/kronk-cli
gh attestation verify kronk-cli-0.1.3.tgz --repo BardiaN/kronk-cli \
  --bundle kronk-cli-0.1.3.tgz.sigstore.json
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
there, so it reports `Failed to log in` under the sandbox even though you are logged in.

You no longer have to know that in advance. When the agent is about to run a command that needs a
credential store the sandbox denies, it asks first:

```console
  1 ⚙ bash: gh issue view 34
  gh reads ~/Library/Keychains, which the sandbox denies.
  allow read-only access for this session? [y/N/always]
```

- `y` grants it for the rest of the session. The seatbelt profile is rebuilt for every command, so
  it takes effect on the next one — no restart.
- `always` also writes the path to `~/.kronk-cli.json` under `sandboxReadable`, so later sessions
  do not ask. It says which file it wrote.
- Anything else declines, and **the command still runs**. Declining is not an error; the command
  fails the way it would have failed anyway, and the result carries a note saying a denial is the
  likely cause.

You are asked at most once per path per session, whichever way you answered. With `--yes` or
`--auto` there is nobody to ask, so the grant is automatic and announced on stderr — piping stdout
still gets only the answer.

The grant is **read-only**. That is the difference from the older escape hatch, which still works
and is still the right tool if you would rather set it before you start:

```bash
KRONK_SANDBOX_ALLOW=~/Library/Keychains kronk-cli
```

`KRONK_SANDBOX_ALLOW` makes a path fully available — **readable *and writable***. For a credential
store that is a poor trade: reading it is what a logged-in CLI needs, and writing to it is what an
attacker needs. The prompt grants only the read.

Be honest with yourself about what you are granting either way: it is the whole `~/Library/Keychains`
directory, not one tool's item in it. macOS `securityd` gates individual items by per-application
ACL independently of file reads, so a process still cannot read another application's item without
your consent — but that is a mitigation on top, not the boundary you drew here.

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
kronk-cli setup                             # first run: model, profile, restart
```

---

## Subcommands

### `kronk-cli setup`

The three things a fresh install needs — the model on disk, an `/AGENT` profile for it, and a
server restart so Kronk reads that profile — walked in order, announcing each step. `--dry-run`
walks the whole thing and prints what it *would* do, which is the safest way to see it:

```console
$ kronk-cli setup --dry-run --model unsloth/Qwen3-0.6B-Q8_0/AGENT

  kronk-cli setup  · dry run, nothing will change

  1) Checking the Kronk server
     http://localhost:11435/v1 · serving 2 models

  2) Resolving the target
     profile  unsloth/Qwen3-0.6B-Q8_0/AGENT
     catalog  unsloth/Qwen3-0.6B-Q8_0
     binary   /opt/homebrew/bin/kronk

  3) Checking whether the model is downloaded
     would run: kronk catalog show unsloth/Qwen3-0.6B-Q8_0 --local

  4) Downloading the model
     would run: kronk model pull unsloth/Qwen3-0.6B-Q8_0

  5) Writing the /AGENT profile
     file  ~/.kronk/models/model_config.yaml
     This block will be added:

       unsloth/Qwen3-0.6B-Q8_0/AGENT:
         context-window: 131072
         nseq-max: 2
         chat-template-kwargs:
           preserve_thinking: true
         sampling-parameters:
           max_tokens: 16384

     would update: ~/.kronk/models/model_config.yaml
     would back up first: ~/.kronk/models/model_config.yaml.bak…

  6) Restarting Kronk
     model_config.yaml is read only when the server starts, so the new
     profile does nothing until Kronk is restarted.
     would run: kronk server stop
     would run: kronk server start --detach

  Dry run complete — nothing was written and nothing was started.
```

| Flag | |
|---|---|
| `--model <id>` | Set up a model other than the default. A trailing `/AGENT` is a Kronk profile name, not a catalog id, so it is stripped before pulling |
| `--context <n>` | Override the profile's `context-window`. Default `131072`, capped at the model's native maximum when Kronk reports one |
| `-y`, `--yes` | Answer every prompt yes. Required in CI |
| `--dry-run` | Print every action, including the exact YAML and the exact commands, and change nothing |

Nothing slow or destructive happens without an answer: the pull, the file write and the restart
are each confirmed. Declining exits 0 and prints the commands you would run by hand. If the
`kronk` binary is not on `PATH`, setup prints the whole manual recipe instead of failing with a
spawn error. Run it twice and the second run does nothing.

Piped or unattended input answers the first question only — readline discards lines nobody is
waiting for — so a question with no answer left is a **no**: setup says `stdin ended, assuming
no`, prints the command, and exits 0. Scripts and CI want `-y`.

**What it writes.** Only the `models:` mapping of `~/.kronk/models/model_config.yaml` — point it
elsewhere with `KRONK_MODEL_CONFIG`. This project has no YAML parser and will not gain one, so
the writer is a structural scan with a single job — find the one `models:` key and splice the
entry beneath it — and it refuses whenever the answer is not obvious:

- The file is copied aside before any write, to `model_config.yaml.bak`, and **never over a
  backup that already exists**: `.bak2`, `.bak3`, and so on until a free name is found.
- Every line it did not add survives byte for byte — comments, blank lines and key order
  included. LF and CRLF files each keep their own endings.
- Missing file → created with `version: 1`, `models:` and the entry. No `models:` key → both are
  appended. A `models:` key with no children → the entry becomes its first child.
- **More than one top-level `models:` key** — two concatenated documents, which does happen in
  the wild — is refused outright. It prints the block, names the file, and exits non-zero
  without touching anything.
- A missing `~/.kronk/models/` means Kronk has never run. Setup says so and stops, rather than
  creating Kronk's data directory on its behalf.

The profile it writes is the one documented under
[Tip: use an `/AGENT` profile](#tip-use-an-agent-profile) — `context-window`, `nseq-max`,
`preserve_thinking` and `max_tokens`, and deliberately no sampling parameters.

---

## Startup: the model is loaded before you type

Kronk has no load command. It lists a model in `GET /v1/models` as soon as the
server starts, but the weights only reach VRAM on the first inference request —
so on a fresh server the first prompt you type pays a 10–30 s cold load, and
looks like a hang.

`kronk-cli` pays it at boot instead. It asks Kronk what is resident, and if the
selected model is not, sends the cheapest completion there is — one token, no
reasoning — to trigger admission:

```console
$ kronk-cli
  loaded   unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT · 11.4s

  ██ kronk-cli  · local agent, no network
```

A model already in the pool is left alone; nothing is sent. If the selected one
cannot be admitted — it will not fit next to what is already resident — the
fallback runs the same order the CLI uses when you name nothing: the configured
default, then the best id Kronk is serving. Each is tried once, and a failure
says why:

```console
$ kronk-cli -m Qwen3.6-27B
  unsloth/Qwen3.6-27B-Q4_K_M failed to load — 507 /chat/completions — insufficient VRAM
  loaded   unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT · 2.0s · fallback
```

If nothing loads, the original pick stands and the first turn reports the real
error. A warm-up is a convenience, not a gate — it never decides whether the CLI
starts.

Skip it with `--no-warm` or `KRONK_WARM=false` and the first prompt pays the load,
as before.

---

## Sampling override warning

The same startup lookup that finds the context window also carries the model's own sampling
recommendations — `general.sampling.temp`, `top_k` and `top_p`, straight from the GGUF — next
to the effective `sampling-parameters` Kronk is actually applying once any profile has been
merged in. `kronk-cli` compares the two and, if a profile is overriding what the model ships,
says so in one grey line under the startup banner:

```console
$ kronk-cli
  ██ kronk-cli  · local agent, no network
  model  unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT
  server http://localhost:11435/v1
  /help for commands · Ctrl-C to interrupt · /exit to quit

  note     profile overrides the model's own sampling: temperature 0.6 (model recommends 1)
```

One line, however many of the three parameters disagree — not one per parameter. It stays
silent when the values agree, when the model ships no `general.sampling.*` metadata at all, or
when the model-info lookup fails: this is information, not a failure, and it never blocks,
prompts, or changes the exit code.

**The fix** is the one described in [Tip: use an `/AGENT` profile](#tip-use-an-agent-profile):
remove `temperature`, `top_k` and `top_p` from the profile's `sampling-parameters` block so
Kronk applies what the model itself recommends.

Since Kronk 1.32.2 this line can fire on a profile you never wrote. That release changed Kronk's
own shipped default for `unsloth/Qwen3.8-27B-UD-Q4_K_XL/AGENT` to pin `temperature: 0.7`,
`top_p: 0.80` and `top_k: 20`, where it previously carried none of the three. The warning is still
accurate — something *is* overriding the GGUF — but the something is the server's authors making a
deliberate choice for that model, not a stale hand-edit. Read it as a fact worth knowing rather
than a defect to repair, and leave it alone unless you have measured otherwise.

Like the rest of the banner, the line is part of the interactive REPL's startup — a one-shot
run (`kronk-cli "prompt"`) prints no banner and prints nothing here either.

---

## Performance

The transcripts above are real sessions, kept to show what the UI looks like — not a benchmark
table, and nothing here reproduced them until now. `scripts/bench.mjs` does: a fixed prompt run
twice for generation speed, a long deterministic filler prompt carried across three turns for
prompt-cache retention, and — only when the target model is not already resident — a cold-load
timing using the same request `warm()` sends at boot. It is a dev tool, excluded from the
published package; run it straight from a checkout:

```bash
node scripts/bench.mjs               # table
node scripts/bench.mjs --json        # same numbers, one JSON object, diffable between runs
node scripts/bench.mjs --skip-cold-load
```

It talks to whatever `KRONK_URL` / `KRONK_MODEL` you already have configured, so the numbers
below are specific to one machine — measure your own rather than trusting these across different
hardware.

Measured 2026-08-23 on an Apple M4 Max, 64 GB RAM (macOS), against
`unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT`, kronk 1.31.9, llama.cpp b10549 — from
`node scripts/bench.mjs`:

```
kronk-bench · model unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT · kronk 1.31.9 · llama.cpp b10549

1. Generation speed
   run 1: 229 tok · 2.97s · 77.1 tok/s · ttft 133ms
   run 2: 220 tok · 2.82s · 78 tok/s · ttft 115ms

2. Prompt cache retention (filler prompt: 5491 tok)
   turn 1: 5518 tok prompt · 5496 tok cached (100%) · 149ms
   turn 2: 5544 tok prompt · 5511 tok cached (99%) · 185ms
   turn 3: 5571 tok prompt · 5537 tok cached (99%) · 160ms

3. Cold load
   skipped — unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT is already resident — a cold load number
   here would be misleading
```

That generation speed and cache-retention region matches the transcripts above (60–80 tok/s,
prompt cache reused above 99% on repeat turns) — this machine's Kronk server is shared with other
work, so a run under contention lands lower in that range and a quiet run lands higher; that
variance is expected, which is why the script reports each run rather than a single averaged
number. The cold-load section only prints a number the one time a run finds the model not
resident — do not stop or unload a shared server's model just to force that path; skip it, the
same way this run did.

---

## Command-line options


| Flag | Default | |
|---|---|---|
| `-m`, `--model <id>` | `unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT` | Model to use. A substring is enough; `/AGENT` profiles win ties |
| `-l`, `--models`, `--list` | — | List the models Kronk is serving, then exit |
| `--no-context` | off | Skip the startup scan of the working directory |
| `--no-compact` | off | Never auto-compact; fail when the window fills instead |
| `--no-warm` | off | Don't preload the model at startup; let the first prompt trigger the load |
| `--mcp [names]` | off | Attach MCP servers — bare for all, or a comma list |
| `--mcp-list` | — | Show configured MCP servers and their tools, then exit |
| `-a`, `--auto` | off | Autonomous: auto-approve tools **and** run until the task is done. Implies `--yes` |
| `-y`, `--yes` | off | Auto-approve `write_file` and `bash` without the autonomous prompt |
| `--no-think` | off | Disable the model's reasoning pass server-side. Much faster |
| `--no-subagents` | off | Remove the `task` tool, so the model cannot delegate — see [Sub-agents](#sub-agents) |
| `--steps <n>` | unlimited | Cap tool calls per task. `0`, `off`, `none`, `inf`, `unlimited` all mean no cap |
| `-h`, `--help` | — | Print all options and exit |
| `--` | — | End option parsing; everything after it is prompt text, dashes and all |

Anything not consumed as an option becomes the prompt, except a token that looks like an
option and is not one: `kronk-cli -auto "…"` exits 2 with `unknown option: -auto` and a
suggestion, rather than folding the typo into the prompt and running with the mode off.
Prose is untouched — a dash followed by a space is not option-shaped, so
`kronk-cli "- fix the dashes bug"` still asks the question — and `--` ends option parsing,
so `kronk-cli -- --explain this` sends `--explain this`. With both an inline prompt and
piped stdin, the two are concatenated.

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
| `/model <id>` | switch model — substring match, `/AGENT` preferred; re-reads that model's window and caps |
| `/file <path>` | add a file to the conversation as context |
| `/auto` | toggle autonomous mode (auto-approve + run to completion) |
| `/steps [n\|off]` | show or set the tool-call cap |
| `/thinking` | show or hide the model's reasoning |
| `/think` | turn reasoning off entirely — much faster |
| `/agents` | the sub-agents `task` can delegate to, and what each may touch |
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
| `KRONK_MODEL_CONFIG` | `~/.kronk/models/model_config.yaml` | Kronk's per-model config, the file `kronk-cli setup` writes |
| `KRONK_MAX_TOKENS` | the model's profile | Output cap per response. Unset, the selected model's own `max_tokens` decides — `8192` only when its profile sets none |
| `KRONK_MAX_STEPS` | unlimited | Cap on tool calls per task |
| `KRONK_THINKING` | `true` | `false` hides reasoning but still generates it |
| `KRONK_NO_THINK` | — | `1` disables reasoning server-side |
| `KRONK_PRESERVE_THINKING` | `true` | `false` stops pinning earlier think blocks in the prompt |
| `KRONK_REPLAY_REASONING` | autonomous-only | `true`/`false` overrides the default in either direction — see [What reasoning gets sent back](#what-reasoning-gets-sent-back) |
| `KRONK_TOOL_TIMEOUT` | `900` | Seconds before a shell command is killed |
| `KRONK_SANDBOX` | `auto` | `auto` confines `bash` when the OS can, `strict` refuses to run it when it cannot, `off` disables it |
| `KRONK_SANDBOX_ALLOW` | — | Paths to make fully available inside the sandbox, comma or colon separated |
| `KRONK_SANDBOX_DENY` | — | Extra paths to hide from `bash`, comma or colon separated |
| `KRONK_CONFIG` | `~/.kronk-cli.json` | Path to the config file, so tests and throwaway runs stay off the real one |
| `KRONK_DISTILL` | `true` | `false` disables tool-output distillation |
| `KRONK_DISTILL_AT` | `8000` | Characters of output that trigger distillation |
| `KRONK_SUBAGENTS` | `true` | `false` removes the `task` tool |
| `KRONK_SUBAGENT_MODEL` | the main model | Model sub-agents run on — substring match, same as `KRONK_MODEL` |
| `KRONK_SUBAGENT_STEPS` | `40` | Tool-call cap for one delegated task |
| `KRONK_WARM` | `true` | `false` skips the boot-time model preload |
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
  "noThink": true,
  "preserveThinking": true,
  "replayReasoning": true,
  "subagentModel": "Qwen3.6-4B",
  "subagentSteps": 40,
  "sandboxReadable": ["~/Library/Keychains"]
}
```

`sandboxReadable` is the list `always` writes at the credential prompt — paths the sandbox lifts
its **read** denial on, and nothing more. Unlike `KRONK_SANDBOX_ALLOW` it never grants writes.
Entries may be absolute or `~`-relative, and one that no longer exists is ignored in silence.

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

Kronk lets one GGUF serve several runtime configurations. `kronk-cli setup` writes this profile
for you, backs the file up first, and offers the restart — see
[Subcommands](#kronk-cli-setup). To do it by hand, add this to
`~/.kronk/models/model_config.yaml` and restart the server:

```yaml
version: 1
models:
  unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT:
    context-window: 131072
    nseq-max: 2
    chat-template-kwargs:
      preserve_thinking: true
    sampling-parameters:
      max_tokens: 16384
```

**Do not set `temperature`, `top_k` or `top_p` here.** Most current GGUFs carry the values
their authors recommend, Kronk reads them, and an explicit block only overrides the model's own
advice. This model ships `general.sampling.temp: 1`, `top_k: 20`, `top_p: 0.95`; an earlier
version of this page recommended `temperature: 0.6`, which quietly fought that. Check what your
model carries with `kronk model show <id> --local`. If a profile does pin one of these,
`kronk-cli` says so at startup — see [Sampling override warning](#sampling-override-warning).

`preserve_thinking` earns its place in an agent profile. The chat template decides per assistant
message whether to render its `<think>` block, and the decision depends on which user message is
the most recent real query. During a tool loop that boundary moves, so the same earlier turn
renders one way now and another way after your next prompt — the prefix changes and the cached
prompt is thrown away. `preserve_thinking: true` renders those blocks the same way every time, so
the prefix stays stable and the server keeps the cache.

Measured on Kronk 1.31.8, on a 13.4k-token conversation with the profile above: the first turn prefilled in
10.9 s with nothing cached, and every following turn reported **13,4xx of 13,4xx tokens cached**
and answered in 1.6 s. *A one-off session, not reproducible from this repo as run — see
[Performance](#performance) for the current, scripted measurement of the same effect.*

**You no longer have to set it.** kronk-cli sends `chat_template_kwargs: {preserve_thinking: true}`
on every chat request, regardless of what the profile says, so an existing profile that predates
this line gets the stable prefix anyway. It is sent only when the selected model's chat template
actually declares the parameter — read from `tokenizer.chat_template` in
`GET /v1/kronk/models/<id>` at startup — and never guessed at when that lookup fails.

It is a trade, not a free win: the retained `<think>` blocks stay in the prompt and cost tokens.
On a small window you may prefer to pay the prefill instead, so `KRONK_PRESERVE_THINKING=false`
(or `"preserveThinking": false` in `~/.kronk-cli.json`) turns it off, and the status line says
`no-preserve` when it is off. With `--no-think` there is no reasoning to preserve and the field is
not sent at all.

### What reasoning gets sent back

`preserve_thinking` decides how the template *renders* a think block. What is in that block is a
separate question, and kronk-cli answers it like this: **the model's reasoning is replayed for the
current task and dropped for everything before it — by default in `--auto`, and never by default
in the interactive REPL.**

Concretely, an assistant message keeps its `reasoning_content` on the wire while it sits after the
most recent real user prompt. A tool result is `role: tool`, so it does not end the task — one
prompt and the whole tool loop it started share the boundary. The moment a new user prompt arrives,
the previous task's blocks are stripped and render empty. That is the same boundary the chat
template computes as `ns.last_query_index`.

Within a task the model reasons about tool result N before it picks tool N+1, and dropping that
makes it re-derive its plan from tool output alone at every step. Those tokens are also
append-only — new on every step, never part of the cached prefix — so replaying them costs nothing
in cache terms. Reasoning from *earlier* turns is the opposite: it sits in the prefix for the rest
of the session, grows without bound, and brings automatic compaction forward.

It is a trade, and the bill arrives at your *next* prompt: stripping the previous task's blocks at
the boundary rewrites the prefix that prompt sits after, so the request resets to the cached system
prompt instead of the cached conversation and re-prefills the rest. Measured on a live server, first
turn after a second prompt, prompt tokens cached vs. re-prefilled:

| | cached | re-prefilled |
|---|---|---|
| never replay | 906 | 60 |
| replay current task | 757 | 516 |
| replay everything | 1,827 | 367 |

`--auto` runs exactly one user prompt through a whole tool loop, so that boundary is never crossed
in a run: the within-task benefit above is free there, and the reset never happens. The REPL is a
user typing repeatedly, so every prompt after the first pays it. Measured over five paired sessions
on Kronk 1.31.9 with `unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT` (llama.cpp `b10549`,
darwin/arm64/metal) with replay forced on for the whole session — the same multi-step task, nine to
twenty-four tool calls depending on the run, followed by the same follow-up question:

| | replay on | replay off |
|---|---|---|
| Prompt tokens at end of session | 10,179 / 11,238 / 7,960 / 10,018 / 9,470 | 20,640 / 8,889 / 10,648 / 10,259 / 13,209 |
| Model turns to finish the first task | 6 / 7 / 2 / 7 / 8 | 9 / 9 / 7 / 7 / 5 |
| Cached tokens on the first turn after the second prompt | 1,222 every run | the whole prefix every run |
| Time to first token on that turn | 5.9 / 7.4 / 4.4 / 5.9 / 6.5 s | 1.2 / 0.8 / 0.9 / 0.7 / 1.1 s |
| Wall clock, three timed pairs | 51 / 63 / 50 s | 68 / 49 / 55 s |

So: fewer turns and fewer prompt tokens over a session, paid for with one re-prefill per prompt —
4.4-7.4 s to first token instead of 0.7-1.2 s once cached. That cost is only worth paying when there
is exactly one prompt to begin with, which is why the default is autonomous-only rather than on
everywhere. Sampling is at the model's own `temperature: 1`, so the turn counts above are indicative
rather than reproducible.

`KRONK_REPLAY_REASONING`, or `"replayReasoning"` in `~/.kronk-cli.json`, overrides the default in
either direction rather than just turning it off: `true` replays reasoning in the REPL too, `false`
turns it off even in `--auto`. Leaving it unset is what gives you the autonomous-only default. It is
off regardless of `--auto` when `--no-think` is set — there is no reasoning to replay — and when the
selected model's chat template does not declare `preserve_thinking`, because such a template does
not read `reasoning_content` either and would discard the blocks.

---

## Context window

Kronk reports the **effective** window for whichever model id you selected — that comes from
`context-window` in `model_config.yaml`, so a `/AGENT` profile and its base model can differ.

Every limit is read from the selected model's profile, and re-read when the selection changes:
the window, the output cap (`sampling-parameters.max_tokens`), whether the chat template
understands `preserve_thinking`, and the model's native maximum. `/model` mid-session moves all
of them, and a sub-agent running on `KRONK_SUBAGENT_MODEL` compacts against *its* window rather
than the main model's. The one number that is not taken from the profile is a `KRONK_MAX_TOKENS`
you set yourself — yours always wins.

Three places surface it:

**The banner**

```
  context  ~/Projects/api · git · AGENTS.md · 131k ctx
```

**Every usage line**, as a meter that fills as the conversation grows:

```
  18471→57 tok · 69.0 tok/s · ttft 397ms · 18260 cached   18k/131k 14% ▓░░░░░░░░░
```

Grey under 70%, yellow past 70%, red past 90%. *Also a real transcript — see
[Performance](#performance) for how to reproduce numbers like these.*

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
| `set_plan` | — | Record the task checklist; replaces the stored one |
| `task` | — | Delegate one job to a [sub-agent](#sub-agents) with its own context |

`set_plan` writes nothing and runs nothing — it hands the harness a list, which is why it is
never gated. See [Autonomous mode](#autonomous-mode) for what the harness then does with it.

`task` is not gated either, because it cannot do anything by itself: every write and every
command a sub-agent asks for comes back to the same prompt you would have seen had the main
agent asked for it.

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

## Sub-agents

The model can hand one job to a **sub-agent**: a fresh agent with its own context window, its
own tool loop, and no memory of your conversation. It runs the task, and the only thing that
ever comes back is its report.

```console
› which tools in this repo need approval, and where is that decided?

  1 ⚙ task explore: list every tool definition in src/, say which are gated and where
   │   1/40 ⚙ search /def\(/ in src
   │   ✓ 9 lines
   │   2/40 ⚙ read src/tools.js
   │   ✓ 587 lines
   │   3/40 ⚙ read src/subagent.js
   │   ✓ 211 lines
   │   2104→380 tok · 58.1 tok/s · 1980 cached
   Six built-in tools. write_file and bash are gated, by NEEDS_APPROVAL at
   src/tools.js:261. MCP tools are gated by name, mcpNeedsApproval at :270.
   read_file, list_dir, search, set_plan and task are not gated.
  ✓ 3 lines

  `write_file` and `bash`, from the `NEEDS_APPROVAL` set in src/tools.js:246…
```

`│` marks the sub-agent's own loop; the unprefixed lines are its report, which is what the main
agent receives as the tool result.

Three files were read. None of them is in your conversation: the 800-odd lines they cost were
spent in a context that no longer exists, and all that is left in your window is the four-line
answer. That is the whole point, and it is the trade [distillation](#distillation) makes for
command output, one level up.

Both agents run against the same Kronk server, so nothing leaves the machine that was not
already leaving it.

### It is not parallelism

Kronk holds one resident copy of the model, so two sub-agents at once queue behind each other
and finish no sooner than two in sequence. Delegation here buys **context**, not wall-clock:
give away the work that is expensive to read and cheap to conclude.

### What it costs, measured

The same survey of `src/` — one table row per module, its responsibility and the gotcha its own
comments call out, plus three facts quoted with `file:line` — run twice per model on this
machine, once with `--no-subagents` and once told to orchestrate. `main ctx peak` is the largest
prompt the *main* conversation ever sent, which is the number the feature exists to move:

| model | mode | wall | main ctx peak | tokens generated | answer |
|---|---|---|---|---|---|
| Qwen3.6-35B-A3B `/AGENT` | plain | 143s | 30.8k | 5.5k | 23/23 |
| Qwen3.6-35B-A3B `/AGENT` | orchestrated, 5 sub-agents | 352s | **12.9k** | 16.2k | 22/23 |
| Ornith-1.5-35B `/AGENT` | plain | 154s | 34.4k | 5.8k | 23/23 |
| Ornith-1.5-35B `/AGENT` | orchestrated, 5 sub-agents | 357s | **5.9k** | 16.5k | 23/23 |

Delegation cut the main conversation's high-water mark by 58% and 83%, and cost roughly 2.4×
the wall clock and 3× the generated tokens to do it. That is the trade in one line: **you are
buying window, and paying for it in time and tokens.** It is worth it when the conversation has
to keep going afterwards, and not worth it for a question you were going to ask once.

The one answer that got worse is worth reading too. Qwen's orchestrated run scored 22/23 because
the sub-agent it asked for "the constant that caps a tool result" came back with a plausible
wrong one from a different module, and the orchestrator had no way to know: it never read the
file. The plain run made the same mistake, spent three rounds re-reading `tools.js`, and caught
it. **A sub-agent's report is evidence you cannot cross-examine** — ask for `file:line` and
verbatim quotes in the prompt, and check the ones that matter.

### The two agents

| Agent | Tools | For |
|---|---|---|
| `explore` | `read_file`, `list_dir`, `search` | Reading, searching, tracing how something works |
| `code` | those plus `write_file`, `bash` | Making a change, running a build, reproducing a failure |

`/agents` prints this in the REPL, with the model and step cap in force.

Two roles rather than a directory of them, because every extra one is a line the model has to
read and choose between on each call, and a local model asked to pick between eight
near-synonyms picks badly. The split that changes what can actually happen is whether it may
touch anything, so that is the split.

### What it cannot do

- **Ask you anything.** There is nobody in its loop. It is told to take the most reasonable
  reading of the task, act, and say what it assumed.
- **Delegate further.** The `task` tool is only ever offered at the top level, which is the
  entire recursion guard.
- **Get a command past you.** Its `write_file` and `bash` calls arrive at the same prompt the
  main agent's do, nested under the call that started them. `--yes` and `--auto` skip them
  exactly as they always did.
- **Touch the checklist.** `set_plan` belongs to the task you asked for; a sub-agent has no
  access to it.
- **Reach MCP servers.** Its tool list is deliberately the short one.

It also runs under a step cap — 40 by default, where the main agent's is unlimited — because
nobody is watching it, and a report is worth less than the window a runaway loop would spend
earning it.

### Knobs

```bash
kronk-cli --no-subagents             # remove the task tool entirely
KRONK_SUBAGENT_MODEL=<id> kronk-cli  # run the grunt work on a different model
KRONK_SUBAGENT_STEPS=80 kronk-cli    # a longer leash per task
```

A sub-agent gets the same startup scan of your project the main agent got, so it starts knowing
what the repo is instead of spending its first two steps finding out.

`KRONK_SUBAGENT_MODEL` needs a model that can actually drive a tool loop, and "smaller" is not
the same thing as "cheaper" here. Measured on the survey task below with `qwen2.5-coder-1.5b`
as the sub-agent model: every sub-agent returned prose without calling a single tool, the main
agent noticed, read all eighteen modules itself, and finished with **47.1k** of context against
the 30.8k it uses when you never delegate at all. A sub-agent that cannot do the work costs you
the delegation *and* the work.

> A small model will not delegate unprompted as often as a frontier one does. Asking for it
> works — *"use a sub-agent to survey the test suite first"* — and is usually how you will
> drive this.

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

**The task checklist.** Long tickets used to end early: the model satisfied one criterion of a
dozen, wrote a confident summary, and stopped. The autonomous prompt now tells it to call
`set_plan` before its first edit, with one item per acceptance criterion, and to update the list
as it goes. The harness holds that list and does two things with it:

- **Re-states it every round.** The open items, verbatim, and how many of how many are done, are
  appended to the last tool result of the round that has just run — so the original request is
  never thousands of tokens behind. Appended, never moved: the conversation only ever grows at
  the end, which is what keeps Kronk's prompt cache alive across a long run. Earlier rounds keep
  the snapshot they were given, and each one says it is a point in time; the last is the current
  one. The list is held outside the message list as well, so [compaction](#compaction) cannot
  summarise it away.
- **Declines the first premature "done".** A reply with no tool calls, while items are still
  open, gets the open list handed back instead of ending the run. Twice at most: after that the
  turn ends and the unfinished items are printed in yellow. `--steps` still wins, and `Ctrl-C`
  still stops everything.

```console
  1 ⚙ plan: 4 items
    · keep the push trigger on master
    ▸ add the concurrency guard
    · document the change in README.md
    · run the linter
```

None of this fires without a plan: if the model never calls `set_plan`, a run behaves exactly as
it did before, and interactive (non-`--auto`) conversation is never held to a checklist. The
model writes the plan; the harness only holds it to it.

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
| `src/plan.js` | the task checklist and the snapshot the model sees |
| `src/subagent.js` | delegation: agent roles, their tools, the report that comes back |
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
| First response takes ~25 s | Cold model load, and you started with `--no-warm`. Drop the flag, or keep the model warm with `--pool-ttl 1h` on the server |
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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and what gets merged quickly. Commits and PR
titles follow [Conventional Commits](https://www.conventionalcommits.org/), and releases follow
npm [semver](https://semver.org/) — a feature or fix PR leaves `package.json` alone, and a
separate release commit bumps the version. Details are in CONTRIBUTING.md.

---

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
