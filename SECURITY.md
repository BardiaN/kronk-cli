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

The egress job is the one that answers *"does it phone home"*. A second step in that job asserts
the namespace really was isolated, so a pass cannot be a false negative. Six static tests back it
up: no URL literal but the local default, every `fetch` targeting a configured host, no raw
network modules, no telemetry identifiers, no runtime dependencies, and `child_process` confined
to the files that are supposed to have it.

Actions are pinned to commit SHAs, and workflow tokens are read-only except in the two jobs that
publish.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting:
*Security → Report a vulnerability* on this repository.

Include what you did, what happened, and what you expected. You should get an
acknowledgement within a few days.

## In scope

- Escaping the sandbox root through path handling
- Executing a command without the approval prompt when one was expected
- Leaking credentials from the environment, config, or MCP servers into output
- Anything that lets a malicious model response run code the user did not approve

## Out of scope

- Behaviour of the models themselves
- Vulnerabilities in Kronk, MCP servers, or the commands the agent runs
- Anything that requires `--yes` or `--auto`, which are documented as removing the safety prompt
