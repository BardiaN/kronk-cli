# Security

## What this tool does

`kronk-cli` runs shell commands and writes files on the machine it is installed on, at the
direction of a language model. `write_file` and `bash` prompt for approval by default;
`--yes` and `--auto` remove that prompt.

It talks only to the Kronk server you configure. It does not phone home.

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
