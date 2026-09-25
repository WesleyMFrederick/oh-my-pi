# Ask

Use Ask only when the likely improvement from the user’s answer exceeds the cost of interrupting their work and context. First research the code, configuration, documentation, history, and conventions. If a safe standard choice exists, act and state it.

## Build the decision

- Put the highest-consequence decision first. Batch only related decisions.
- Keep the total decision brief near 150 words.
- In `question`, state the decision, what exists now, shared facts, and how earlier decisions limit the options.
- Translate technical terms at first use. Explain how counterintuitive claims work.
- Offer 2–5 materially distinct `options`.
- Put the recommendation first with `recommended: 0`, unless natural ordering makes selection easier.
- Give each option a short, outcome-based `label`.
- Use `description` for one line covering outcome, cost, and risk.
- Use optional rich Markdown `preview` only for extra evidence or detail.
- Use optional `header` only to group related questions.
- Use `multi: true` only when multiple selections are valid.

Recommendations MUST be honest defaults; NEVER hide tradeoffs. NEVER supply an Other option; the user interface adds it.

Question headings collapse after 4 rows. Descriptions collapse after 2 rows. Ctrl+O expands them. Previews support full Markdown.

After the user answers, act on the decision and show the result.
