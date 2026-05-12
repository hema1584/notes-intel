# notes intel v1.1

> A personal AI-powered QA assistant for the Tactile Entertainment QA team.  
> Turns raw inputs into structured test cases and pushes them directly to Jira.

---

## What it does

Paste meeting notes, a Confluence page, Slack thread, or Jira ticket — notes intel reads everything, gives you a smart briefing, generates ranked QA focus points with full test cases, spots player-perspective risks, and pushes subtasks to Jira in one click.

---

## How to use

**Option 1 — GitHub Pages (recommended)**  
Open directly in your browser — no install, no setup:  
👉 **[https://hema1584.github.io/notes-intel/](https://hema1584.github.io/notes-intel/)**

> Requires Claude access. Works best when opened inside claude.ai.

**Option 2 — Local file**  
Download `index.html` → open in Chrome. All features work locally.

---

## Input sources

| Source | How |
|---|---|
| Notes / transcript | Paste directly into the text area |
| Confluence page | Click **confluence** → paste URL or page ID |
| Slack thread | Click **slack** → paste message link |
| Jira ticket | Click **jira ticket** → paste ticket ID or URL |
| Screenshot | Click **screenshot** → pick image file |

---

## Output

### 🟢 Gist
A QA briefing card — crisp summary, feature overview, acceptance criteria, and test scope chips derived from the actual content. Designed to brief a QA engineer in 30 seconds.

### 🟡 QA Focus
5 ranked test cases tied to the ticket content and Jira comments. Flow-aware — related checks are combined into one test case rather than split across 5 slots. Each test case includes objective, preconditions, steps, and expected result.

### 🔴 Risk Scenarios
Player-perspective risk analysis — race conditions, offline edge cases, interrupted flows, UI state mismatches. Each risk shows the failure mode and where to look in code.

### 🔵 Push to Jira
Pushes selected test cases as subtasks on a parent ticket. Auto-detects issue type per board (`Test Case` vs `Subtask`). Description formatted as ADF (Atlassian Document Format) with proper headings and numbered steps.

---

## Project context

Fill in the **Project Context** card once — it's saved automatically and silently included in every analysis. Fields: product/platform, QA focus areas, team terminology, output style preference.

---

## Requirements

- Claude account (Pro or Team)
- Atlassian MCP connected in claude.ai (for Jira push)
- Slack MCP connected in claude.ai (for Slack thread reading)

---

## Tech

Single HTML file — no build step, no server, no dependencies at runtime.  
Models: **Haiku** for gist and QA generation · **Sonnet** for MCP calls and Jira push.

---

*Built for Tactile Entertainment QA · notes intel v1.1*
