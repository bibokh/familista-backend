# caveman (vendored Claude Code skill)

Development tooling only. Nothing in the Familista application, build, tests or
deployment reads this folder. Claude Code loads `SKILL.md` into context only
when the skill is invoked (`/caveman`), so an idle install costs one line in the
skill list.

## Provenance

| | |
|---|---|
| Upstream | https://github.com/JuliusBrussee/caveman |
| Version | v3.2.0, tag commit `e20f07e8152a0c0360f58c09e79d30ac94329991` |
| File | `skills/caveman/SKILL.md` |
| Upstream SHA-256 | `415d43518f2b1a9498c15a445d4657117b129ee5e81b19454ce348439cc6672b` |
| Licence | Apache-2.0 (`LICENSE` in this folder) |
| Attribution | Caveman, Copyright 2026 Julius Brussee |

Modified: one provenance comment after the front matter and the
"Familista guardrails" section at the end of `SKILL.md`. Everything between is
the upstream file byte for byte.

Installed as the skill alone. Not installed: the Claude Code plugin and its
hooks (SessionStart, SubagentStart, UserPromptSubmit, SessionEnd), the
statusline, the `@caveman-ai/cli` proxy, MCP server, `browse`, or any other
package. The skill makes no network calls and needs no API key.

## Use

- `/caveman` turns it on for the session. `stop caveman` or `normal mode` turns it off.
- `/caveman status` reports the mode.

## Disable or uninstall

- One session: say `stop caveman`.
- Uninstall: `git rm -r .claude/skills/caveman` and commit, or `git revert` the
  commit that added it. No other file was changed.

## Update

Replace everything after the provenance comment, up to the "Familista guardrails"
heading, with the new upstream `skills/caveman/SKILL.md`. Then update the version,
commit and SHA-256 above. Read the upstream diff before you take it.
