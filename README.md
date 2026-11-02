<p align="center">
  <img src="assets/logo.svg" alt="TapVid" width="240">
</p>

<p align="center">
  <strong>Open-source agent skills by SigmaMatrix AI for video creation</strong>
</p>

<p align="center">
  <a href="https://tapvid.ai?utm_source=tapvid-skill"><img src="https://img.shields.io/badge/Website-TapVid-78D701?style=flat" alt="Website: TapVid"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-blue?style=flat" alt="License: Apache-2.0"></a>
  <a href="#available-skills"><img src="https://img.shields.io/badge/Skills-Explore-8A2BE2?style=flat" alt="Skills: Explore"></a>
</p>

Each skill includes instructions and supporting resources for a specific workflow. Install only the skills you need.

## Available skills

| Skill | What it does | Best for | MCP dependency |
| --- | --- | --- | --- |
| [Remix](skills/remix/README.md) | Turn a reference video into a reusable template, then create a new video for your topic. | Creators and product marketers | None |

Open a skill's README for examples, setup instructions, and supported environments.

## Install a skill

You can install individual skills without installing the entire collection.

### Ask your agent

Tell your agent which skill to install. For example:

```text
Install the Remix skill from https://github.com/SigmaMatrix-AI/tapvid
```

### Codex

In a local Codex environment with `skill-installer` available, ask:

```text
$skill-installer install https://github.com/SigmaMatrix-AI/tapvid/tree/main/skills/remix
```

Replace `remix` with the skill you want. This is a prompt for Codex, not a terminal command.

### Claude Code

Download or clone this repository, then copy the selected skill's entire folder, including its supporting files, into either:

- `~/.claude/skills/` — available across your local projects.
- `.claude/skills/` — available within a specific local project.

For example, Remix's entry file should be located at:

```text
~/.claude/skills/remix/SKILL.md
```

After installation, check the skill's README for additional dependencies and setup. If the skill does not appear, start a new agent session.

## Check the version and update

A skill's version is `metadata.version` at the top of its `SKILL.md`.

To update, ask your agent:

```text
Update the Remix skill from https://github.com/SigmaMatrix-AI/tapvid
```

Or download this repository again and copy the skill's folder over the installed one. Back up any local edits first, and replace the existing folder rather than nesting another copy inside it. Then start a new agent session.

## Service access

Each skill's README explains any MCP connections, external APIs, or accounts it needs. Installing a skill does not automatically configure or grant access to those services. Accounts, credentials, and usage charges are managed separately by each provider.

The skills in this repository are open source. External service implementations are maintained separately and are not included here.

## License

[Apache-2.0](LICENSE). Third-party components and downloaded content retain their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
