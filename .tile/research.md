# TripIt → Reclaim Timezone Sync: Tile Research

**Date:** 2026-03-27
**Repo:** https://github.com/jbaruch/reclaim-tripit-timezones-sync
**Proposed tile:** `jbaruch/tripit-reclaim` (generic — not NanoClaw-specific, any agent can use it)

---

## 1. Environment Variables Reference

### Mandatory

| Variable | Purpose |
|---|---|
| `TRIPIT_ICAL_URL` | Private TripIt iCal feed URL. Found in TripIt account settings. The tool fetches this to extract flight and hotel timezone data. |
| `RECLAIM_API_TOKEN` | Reclaim.ai API token for authenticating REST calls that update travel timezone settings. |

### Optional — Telegram Notifications

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token for sending Telegram alerts when timezone overrides change. |
| `TELEGRAM_CHAT_ID` | Chat/user ID that receives the Telegram alerts. Requires `TELEGRAM_BOT_TOKEN` to be set. |

**Note:** These two work independently of the Google Calendar integration. If both are set, the bot fires a message whenever the sync detects a change.

### Optional — Google Calendar OOO Blocks

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth2 client ID. All three Google vars must be present to activate OOO syncing. |
| `GOOGLE_CLIENT_SECRET` | OAuth2 secret, paired with the client ID. |
| `GOOGLE_REFRESH_TOKEN` | Refresh token for persistent Calendar API access without re-auth. |

**Note:** When all three are present, the tool creates Google Calendar out-of-office blocks for trips at P2 priority (instead of default P1), enabling a "critical-only" scheduling link that stays bookable through travel dates.

### Optional — Trip Filtering

| Variable | Purpose | Default |
|---|---|---|
| `TRIPIT_IGNORE_TRIPS` | Comma-separated trip names to exclude (case-insensitive substring match). Useful for family trips you're tracking in TripIt but not attending. | Empty (no trips ignored) |
| `TRIPIT_IGNORE_KEYWORDS` | Comma-separated keywords — any trip whose name contains one is excluded. Works alongside `TRIPIT_IGNORE_TRIPS`. | Empty (no filtering) |

**Note:** Ignored trips are excluded from both timezone segments AND OOO calendar blocks.

### Optional — Tuning

| Variable | Purpose | Default |
|---|---|---|
| `OOO_RETRY_DELAY_MS` | Millisecond delay before retrying priority assignment for newly created OOO events. Google Calendar occasionally needs a moment before the API accepts priority changes. | `60000` (60 seconds) |

### Optional — AWS Deployment Only

| Variable | Purpose |
|---|---|
| `SNS_TOPIC_ARN` | ARN of an AWS SNS topic for email notifications on sync changes. AWS-only alternative to Telegram notifications. Format: `arn:aws:sns:REGION:ACCOUNT_ID:reclaim-tripit-sync`. |
| `AWS_REGION` | AWS region for Fargate/ECR/CloudWatch resource deployment. Set externally during infra setup, not part of the app's `.env`. |

---

## 2. Tile Design: `jbaruch/tripit-reclaim`

### Tile identity

- **Tile name:** `jbaruch/tripit-reclaim`
- **Primary skill:** `sync-tripit`
- **Generic:** Any Claude agent (NanoClaw, Desktop Claude, etc.) can install and use this tile
- **Key principle:** The sync itself is fully deterministic — no stochastic/LLM behavior in the actual sync. The script runs, produces human-readable text output, done. AI is used only to interpret and present results.

### Core rule (always-on)

The tile includes one always-on rule:

> **Never implement sync logic yourself.** Always run `sync.mjs` via the provided shell script. The sync is deterministic code — your role is to execute the script and interpret its output. Do not call TripIt or Reclaim APIs directly, do not reconstruct timezone logic, do not improvise.

### Runtime: lazy install pattern

The skill checks for the library and downloads it on first use — no pre-baking in Dockerfile, no git client required:

```bash
if [ ! -f /opt/tripit-reclaim/sync.mjs ]; then
  mkdir -p /opt/tripit-reclaim
  curl -sL https://github.com/jbaruch/reclaim-tripit-timezones-sync/archive/refs/tags/v0.2.0.tar.gz \
    | tar xz --strip-components=1 -C /opt/tripit-reclaim
  cd /opt/tripit-reclaim && npm ci --omit=dev
fi
node /opt/tripit-reclaim/sync.mjs sync --output=json
```

### `sync-tripit` skill — architecture

**Step 1: Run the script (deterministic)**
- Check if `/opt/tripit-reclaim/sync.mjs` exists; if not, download + install (see above)
- Run `node /opt/tripit-reclaim/sync.mjs sync`, capture stdout/stderr

**Step 2: Process output (AI-assisted)**

The script output is **human-readable text, not JSON**. The skill must parse it by reading the text. Key signals to detect:

**No-changes run** — look for this line in stdout:
```
No timezone changes detected — skipping timezone sync.
```
If this appears AND no OOO changes (`0 created, 0 deleted, 0 set to P2`) → silent, send nothing.

**Changes detected** — look for lines like:
```
Creating: America/Chicago (2026-04-01 → 2026-04-05)
Created 2 entries
OOO sync: 1 created, 0 deleted, 1 set to P2
```
Summarize what changed: new timezone segments, OOO blocks created/deleted, P2 priorities set.

**Timezone segments summary** — always printed, between the `── Timezone segments ──` and next `──` header:
```
  Trip name
    2026-04-01 → 2026-04-05  [America/Chicago]
```

**Overlapping trips** — printed to stdout before the segments summary if overlaps exist:
```
⚠️  OVERLAPPING TRIPS:
  Trip A (→ 2026-04-05) overlaps Trip B (2026-04-03 →)
```
Each line names both trips and the overlapping date boundary. Flag these as a warning in the output — they produce potentially conflicting timezone segments.

**Errors** — go to stderr, fatal errors look like:
```
FATAL ERROR: <message>
<stack trace>
```
Also on stderr: missing env vars (`Missing TRIPIT_ICAL_URL environment variable`). Exit code is 1 on any fatal error.

**Dry-run mode** ends with:
```
Dry run complete. No changes made to Reclaim.
```
Useful for onboarding/credential verification.

**OOO retry warning** (non-fatal, on stdout):
```
  N new event(s) not yet in Reclaim — retrying priority in Xs...
```
This is informational; the script handles the retry itself.

Apply filtering logic:
- No changes detected → silent (send nothing)
- Changes detected → summarize what changed (new timezones, removed segments, OOO blocks created)
- Overlapping trips detected → flag with warning; include trip names and conflicting dates
- Errors (stderr / exit code 1) → report with context

**The skill is channel-agnostic** — it produces output, the calling agent decides how to present it.

**Skill file location in tile:** `skills/sync-tripit.md`

---

## 3. Onboarding Skill Design

### The three options

**Option A: Interactive prompting**
The onboarding skill asks the user for each variable one at a time via chat. Works in any interface, no file system access required. Annoying for 8+ variables. Error-prone (copy-paste into chat, token leakage in logs).

**Option B: Accept `.env` file path**
User uploads or places a `.env` file somewhere accessible and tells the skill the path. The skill reads and parses it. Clean, fast, familiar to developers. Requires the file to exist in a path the container can reach — friction on initial setup.

**Option C: Paste all vars directly**
User pastes the full `.env` content in one message. Single interaction. But tokens appear in chat logs, which is a security liability for API keys and OAuth tokens.

### Vars relevant to skill deployment

When running as a skill, the agent handles all input/output/reporting — Telegram and AWS notification vars are irrelevant and should NOT be asked during onboarding:

| Category | Vars | Include in skill setup? |
|---|---|---|
| Mandatory | `TRIPIT_ICAL_URL`, `RECLAIM_API_TOKEN` | ✅ Always |
| Google OOO blocks | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | ✅ Optional feature |
| Trip filtering | `TRIPIT_IGNORE_TRIPS`, `TRIPIT_IGNORE_KEYWORDS` | ✅ Optional |
| Tuning | `OOO_RETRY_DELAY_MS` | ✅ Optional |
| Telegram notifications | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | ❌ Skip — agent handles output |
| AWS deployment | `SNS_TOPIC_ARN`, `AWS_REGION` | ❌ Skip — different deployment model |

### Recommendation: Option B with Option A fallback

**Primary path: accept `.env` file path.**

The target user (a developer) will almost certainly already have a `.env` file from running this locally. The onboarding skill should:

1. Ask: "Do you have a `.env` file for this tool? Drop it at `/workspace/group/tripit-reclaim.env` and let me know."
2. Parse the file, validate that mandatory vars are present, silently ignore Telegram/AWS vars.
3. Report which optional features are enabled (Google OOO, filtering).
4. Offer to run a `--dry-run` immediately to confirm credentials work.

**Fallback: interactive prompting** for mandatory vars only, optional vars as a second pass.

**Never**: paste all vars directly into chat — token exposure in message history.

---

## 4. Secrets Storage

### Options and trade-offs

**Option A: NanoClaw container environment variables**
Set `TRIPIT_ICAL_URL`, `RECLAIM_API_TOKEN`, etc. directly in the container's environment at runtime.
- Pros: Standard 12-factor app pattern, zero code changes, works natively with `sync.mjs`
- Cons: Secrets live in container config/orchestration layer; depends on how NanoClaw exposes this — if via a config file, that file needs to be secured
- Verdict: Good if NanoClaw has a proper secrets store behind the env injection mechanism

**Option B: Encrypted file in `/workspace/group/`**
Store a `tripit-reclaim.env.enc` file, decrypt at runtime with a master key.
- Pros: Auditable, version-control friendly (encrypted), survives container restarts
- Cons: Need a key management story (where does the decrypt key live?); adds complexity; `/workspace/group/` may not be the right secrets boundary
- Verdict: Overkill for this use case unless there's already an encryption infrastructure in NanoClaw

**Option C: Reference to host `.env` file**
Mount a `.env` file from the host into the container at a known path.
- Pros: Simple, keeps secrets off the container image, familiar developer workflow
- Cons: Ties the tile to a specific host filesystem path; breaks portability; host file permissions become the security boundary
- Verdict: Fine for single-machine local deployments, bad for anything that might move

**Option D: Composio secrets store**
Use Composio's credential management to store and inject secrets.
- Pros: Purpose-built for this, access-controlled, works across tools and agents
- Cons: Adds a Composio dependency; requires Composio to support arbitrary key-value secrets (vs. just OAuth flows); integration work needed
- Verdict: Best long-term option IF Composio supports arbitrary secrets injection; worth investigating

### Recommendation

**Short term:** Option A (NanoClaw container env). Store secrets as NanoClaw-managed environment variables for the tile. This is the path of least resistance and matches how the existing Docker deployment works. The onboarding skill writes parsed vars into NanoClaw's secret store via the tile config API.

**Long term:** Option D (Composio secrets). As NanoClaw's Composio integration matures, migrate to Composio for unified secret management across all tiles.

**Avoid:** Plaintext files in `/workspace/group/` with tokens. If a file must be used, encrypt it, but that's complexity without much gain at this stage.

---

## 5. Branch Strategy

### Tile location: NanoClaw repo, baked at build time

The tile lives in the NanoClaw repo at `/workspace/project/tiles/tripit-reclaim/`, not in the upstream sync repo. It is baked into the NanoClaw container at build time — no runtime download of tile files.

This is NanoClaw-specific implementation detail. The tile itself is generic and published to the Tessl registry. Other agent clients (OpenClaw, Desktop Claude, etc.) install it the standard way:

```
tessl install jbaruch/tripit-reclaim
```

**Tile file layout (in NanoClaw repo):**
```
/workspace/project/tiles/tripit-reclaim/
  tile.json                        # Tile manifest: name, env var declarations, skills
  skills/
    sync-tripit/SKILL.md           # sync-tripit skill definition
    onboard/SKILL.md               # Onboarding skill definition
  rules/
    tripit-reclaim.md              # Always-on rule: never implement sync logic yourself
```

**Publishing to Tessl registry:**
```
tessl publish
```

The lazy install script (in SKILL.md) still pulls the sync library (`sync.mjs`) from `main` at first run — that's the app code, not the tile files. Tile files and app code are separate concerns.

---

## 5b. Auth for `tessl install jbaruch/tripit-reclaim`

_Researched 2026-03-27 — answers the question: can you do `tessl install jbaruch/tripit-reclaim` non-interactively in a Dockerfile?_

### Short answer

Yes. Use the `TESSL_TOKEN` environment variable. No `--token` flag exists on `tessl install`.

### Full pattern

**Generate the token once** (requires existing interactive login):
```bash
tessl auth token
# or with expiry date:
tessl auth token --expiry-date 2026-12-31
```

**Use in Dockerfile:**
```dockerfile
ENV TESSL_TOKEN=<your-api-token>
RUN tessl install jbaruch/tripit-reclaim
```

**Use in CI/CD (GitHub Actions):**
```yaml
- run: tessl install jbaruch/tripit-reclaim
  env:
    TESSL_TOKEN: ${{ secrets.TESSL_TOKEN }}
```

### Public tile caveat

Since Tessl v0.62.2, public tiles (`private: false` in tile.json) can be installed **without any authentication**. Once `jbaruch/tripit-reclaim` is published as a public tile, `tessl install jbaruch/tripit-reclaim` will work in a Dockerfile with zero auth setup. `TESSL_TOKEN` is only required for private tiles.

### What does NOT work

- `tessl install jbaruch/tripit-reclaim --token=<TOKEN>` — this flag does not exist
- `tessl install jbaruch/tripit-reclaim --auth-token=<TOKEN>` — does not exist
- There is no per-command token flag. Environment variable only.

---

## 6. Tile Manifest Format

Based on `nanoclaw-core`'s `tile.json`, the manifest format is:

```json
{
  "name": "owner/tile-name",
  "version": "0.1.0",
  "summary": "One-sentence description of what the tile provides.",
  "private": false,
  "rules": {
    "rule-name": {
      "rules": "rules/rule-name.md"
    }
  },
  "skills": {
    "skill-name": {
      "path": "skills/skill-name/SKILL.md"
    }
  }
}
```

**For `jbaruch/tripit-reclaim`, the tile.json should look like:**

```json
{
  "name": "jbaruch/tripit-reclaim",
  "version": "0.1.0",
  "summary": "Syncs TripIt travel itineraries to Reclaim.ai timezone segments and Google Calendar OOO blocks. Provides sync-tripit skill (run sync, interpret output) and onboard skill (guided credential setup).",
  "private": false,
  "rules": {
    "tripit-reclaim": {
      "rules": "rules/tripit-reclaim.md"
    }
  },
  "skills": {
    "sync-tripit": {
      "path": "skills/sync-tripit/SKILL.md"
    },
    "onboard-tripit-reclaim": {
      "path": "skills/onboard/SKILL.md"
    }
  }
}
```

**Notes on the format:**
- `name` follows `owner/tile-name` convention (matches the nanoclaw-core pattern)
- `private: false` — this tile is generic, not NanoClaw-specific
- `rules` block contains always-on rules loaded when the tile is installed (the "never implement sync logic yourself" rule lives here)
- `skills` block lists on-demand skills; `path` is relative to the tile root (the `.tile/` directory in the repo)
- No env var declarations in the manifest itself — env vars are documented in the skill files and handled by the onboarding skill

---

## 7. Open Questions

1. ~~Does NanoClaw have a native secrets/env var store?~~ **Resolved:** Container env vars. Store `TRIPIT_ICAL_URL`, `RECLAIM_API_TOKEN`, etc. in the container's environment (NanoClaw `data/env/env` file).

2. ~~Google OAuth — assume token exists or interactive flow?~~ **Resolved:** Instructions exist in the repo README. Skill should attempt an interactive OAuth flow if the agent supports it — this is the better UX. Fall back to "here's how to get the token manually" if not.

3. ~~SNS/Telegram vars — exclude?~~ **Resolved:** Yes, explicitly excluded. When running as a skill, the agent IS the notification layer — Telegram bot tokens and SNS ARNs are irrelevant by definition.

4. ~~Tile registry / publish flow for `jbaruch/`-namespaced tiles.~~ **Resolved:** Tile published to Tessl registry (`tessl publish`). Installation is implementation-specific — NanoClaw bakes tiles into the container at build time; other clients use `tessl install jbaruch/tripit-reclaim`.

---

## Summary

**Mandatory vars:** `TRIPIT_ICAL_URL`, `RECLAIM_API_TOKEN`
**Key optional groups:** Telegram (2 vars), Google OOO (3 vars), filtering (2 vars), tuning (1 var), AWS-only (2 vars, skip)
**Tile:** `jbaruch/tripit-reclaim` with `sync-tripit` and `onboard-tripit-reclaim` skills
**Output format:** Human-readable text (not JSON) — will switch to JSON once issue #9 (JSON output flag) is implemented; skill currently parses by text pattern matching
**No-changes signal:** `No timezone changes detected — skipping timezone sync.` + OOO stats `0 created, 0 deleted`
**Overlap signal:** `⚠️  OVERLAPPING TRIPS:` block in stdout, one line per overlapping pair
**Onboarding:** File-path primary, interactive fallback, never paste tokens in chat
**Secrets:** NanoClaw env store now, Composio later
**Tile location:** NanoClaw → `/workspace/project/tiles/tripit-reclaim/` (baked into container at build time); generic install → `tessl install jbaruch/tripit-reclaim`
**Night maintenance:** `sync-tripit` will eventually be added to a `night-maintenance` skill (like `morning-brief` but nightly). Not designed yet.

---

## Status

- ✅ All design decisions made
- ✅ All open questions resolved
- ⏳ Blocked on: issue #9 (JSON output flag) — implement before writing final skill
- Next: create tile files (`tile.json`, `sync-tripit` SKILL.md, `onboard` SKILL.md, rule file) once #9 is done
