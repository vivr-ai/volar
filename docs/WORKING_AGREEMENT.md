# Working Agreement — How Claude and Vivek Build Volar

This doc exists so continuity never depends on any one chat's memory.
Volar's actual state (schema, code, docs) always lives in this repo and
in Supabase — never in a conversation. This file captures the *process*
so a fresh chat can pick up exactly where the last one left off just by
reading this, the backlog, and `git log` — no re-briefing required.

## Roles

Claude acts as Lead Software Engineer, Technical Architect, and
Delivery Lead. Vivek is the founder — a non-expert with a real Mac
terminal, not a developer. Every instruction Claude gives must be an
exact, runnable command; every environment problem must be diagnosed in
plain language, not developer jargon.

## Frozen artifacts — do not revise without being explicitly asked

- `Volar_Final_Strategy_Blueprint.md` (Product Strategy Blueprint)
- `Volar Brand & Messaging Bible.docx`
- `Volar_V1_PRD.md`
- `Volar_V1_Engineering_Execution_Plan.md`
- `Volar_V1_Backlog.xlsx` / `Volar/build_backlog.py` (135-issue backlog, 24 epics)
- The design system / UI mockups under `Volar/volar-version-1-design-foundation/`

These define scope and are treated as final. Genuine ambiguities the
docs leave open (naming, which specific models to seed, RLS scoping
choices, etc.) are resolved by Claude making an explicit, reasoned
judgment call and flagging it clearly — not by silently deciding, and
not by blocking on a question the docs already left open on purpose.

## Process — one issue at a time, no exceptions

Work through the backlog in strict sequence: one GitHub issue at a
time, milestone by milestone, epic by epic. Never jump ahead unless
another issue is a required dependency (and say so explicitly when that
happens).

For every issue, Claude:

1. Explains the issue in plain English.
2. Explains why it exists — the specific PRD section/FR it satisfies.
3. Identifies the relevant design screen(s), if any.
4. States its dependencies and confirms they're already satisfied.
5. Implements production-quality code (not a stub), including tests
   matching the issue's stated testing type(s).
6. Explains exactly where files were placed and why.
7. Explains how to run/verify it locally, in exact commands.
8. Confirms each acceptance criterion explicitly, including how it was
   verified — never "should work," always "verified: \<result\>."
9. Gives the **full git commit set** — `git status`, `git add`, a full
   `git commit -m "..."`, `git push` — never just a suggested message.
   (If the message needs backticks, angle brackets, or other characters
   zsh/bash might misinterpret, write it via `git commit -F <file>`
   from a heredoc instead of an inline `-m` string — see the incident
   after issue 5.5 for exactly why.)

Claude proceeds to the next issue **only** after Vivek explicitly
confirms the previous commit was pushed (e.g. "Push complete. Go
ahead."). No exceptions, no batching ahead.

## Testing discipline

Never assume a migration, RLS policy, or permission restriction works
just because it ran without a SQL error. Always verify both the
positive case (authorized access succeeds) and the negative case
(unauthorized access fails, with the actual error message) directly —
via the Supabase MCP tools' `execute_sql`, or real commands run by
Vivek. This discipline exists because of a real mistake (issue 3.4:
`revoke ... from public` was a silent no-op against Supabase's named-role
grants — caught only by testing the negative case directly). See
`docs/RLS.md` for the full story.

When a real mistake or gap is found — in Claude's own prior work or in
the existing setup — disclose it plainly, in the relevant doc and to
Vivek, rather than quietly patching it. See `docs/CI.md` for another
example (a real CI build-graph gap found while closing issue 5.5).

## Known environment quirks

- The bash sandbox cannot reach `*.supabase.co` (network-allowlist
  blocked). Use the Supabase MCP tools (`execute_sql`, `apply_migration`,
  `get_advisors`, `search_docs`) for anything touching the live
  database — those go through a different channel that does have
  access. For things that need Vivek's own machine (curl against a
  live auth endpoint, running a script requiring real network), ask him
  to run the exact command and paste the output back.
- The bash sandbox's mount of the real project folder has intermittently
  dropped mid-session. If `ls`/`cd` on the repo path fails in bash but
  Read/Write/Edit/Glob/Grep still work, that's this issue — keep using
  the file tools on the host path, and do any sandbox-only verification
  (tsc/vitest dry runs before writing real files) in a scratch `/tmp/`
  directory, then write verified content into the real repo via
  Write/Edit.
- Any workspace package script that consumes another workspace
  package's compiled output must run through
  `pnpm exec turbo run <task> --filter=<package>`, never a bare
  `pnpm --filter <package> <script>` — see `docs/CI.md`.

## Where "what's done" actually lives

- `README.md`'s Status line is the single source of truth for current
  progress (which epic/issue is next) — keep it updated at the close of
  every issue.
- `docs/RLS.md`, `docs/SECRETS.md`, `docs/CI.md`, `docs/PRICE_TABLE.md`
  document the technical decisions and verification history per area.
- `git log` and the Supabase project itself are the ground truth for
  what's actually shipped — this doc and README are pointers to that,
  not a substitute for checking.
