## Agent skills

### Issue tracker

Issues live in GitHub Issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to themselves (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Image understanding

For images, screenshots, diagrams, charts, mockups, and other visual-analysis tasks, prefer the model's native vision capability. Do not prioritize or proactively invoke the `vision` skill when the model can inspect the image directly. Use the `vision` skill only when the user explicitly requests it, native vision is unavailable or insufficient, or the task specifically requires an external vision model or endpoint.
