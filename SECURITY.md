# Security

## What this tool does

`kronk-cli` runs shell commands and writes files on the machine it is installed on, at the
direction of a language model. `write_file` and `bash` prompt for approval by default;
`--yes` and `--auto` remove that prompt.

It talks only to the Kronk server you configure. It does not phone home.

## How that claim is checked

Independent scanning runs on every pull request and weekly on a schedule:

| | |
|---|---|
| **CodeQL** (`security-extended`) | taint tracking — user input reaching a shell command or a network call |
| **OpenSSF Scorecard** | supply-chain posture, published publicly |
| **Dependabot** | npm and GitHub Actions dependencies |
| **`npm audit`** | fails the build at moderate severity and above |
| **zizmor** | audits the workflows for injectable expressions and over-broad tokens |
| **Egress proof** | the CLI is run inside a network namespace containing only loopback, against a stub server, and must still complete a turn |
| **Sandbox proof** | `bash` is run under the OS sandbox and must fail to write outside the project or read a planted key; a missing backend fails the job rather than skipping |

The egress job is the one that answers *"does it phone home"*. A second step in that job asserts
the namespace really was isolated, so a pass cannot be a false negative. Six static tests back it
up: no URL literal but the local default, every `fetch` targeting a configured host, no raw
network modules, no telemetry identifiers, no runtime dependencies, and `child_process` confined
to the files that are supposed to have it.

Actions are pinned to commit SHAs, and workflow tokens are read-only except in the two jobs that
publish.

## Supported versions

| Version | Supported |
|---|---|
| latest release | ✅ |
| anything older | ❌ — upgrade first, then report |

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting:
[Security → Report a vulnerability](https://github.com/BardiaN/kronk-cli/security/advisories/new).

Include what you did, what happened, and what you expected.

**What to expect**

| | |
|---|---|
| Acknowledgement | within 3 working days |
| Initial assessment | within 7 days |
| Fix or mitigation for a confirmed high-severity issue | within 30 days |
| Public disclosure | after a fix ships, or 90 days, whichever comes first |

If you would like credit in the advisory, say so and how you want to be named.
Reports are welcome from anyone; there is no bounty.

## What the sandbox does and does not cover

`bash` runs under `sandbox-exec` (macOS) or `bwrap` (Linux) where the OS allows it. That denies
writes outside the project and reads of credential directories. It does **not** block the network
or reads elsewhere, because the agent has to be able to run builds — so it limits what a bad
command reaches, rather than making one safe. `bwrap` needs unprivileged user namespaces; where
those are disabled the banner says the shell is unconfined, and `KRONK_SANDBOX=strict` refuses to
run it at all.

The file tools are confined separately, in-process, and resolve symlinks before checking
containment.

## In scope

- Escaping the sandbox root through path handling
- Executing a command without the approval prompt when one was expected
- Leaking credentials from the environment, config, or MCP servers into output
- Anything that lets a malicious model response run code the user did not approve

## Out of scope

- Behaviour of the models themselves
- Vulnerabilities in Kronk, MCP servers, or the commands the agent runs
- Anything that requires `--yes` or `--auto`, which are documented as removing the safety prompt
