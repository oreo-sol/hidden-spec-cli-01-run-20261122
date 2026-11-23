[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/oreo-sol/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/oreo-sol/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats —
a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
text-editor tool calls as JSON — and mend reads each one as `SPEC.md` says, finds the lines each edit names
at the first of three matching tiers (exact, trailing whitespace, leading and trailing whitespace), and
writes every change or none, printing what it changed or why it failed.

Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`, Node 22, standard library alone.
`SPEC.md` is the whole contract. The practice set scores 100/100 (practice score 1000).

Entry for the [hidden-spec-cli-01 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
