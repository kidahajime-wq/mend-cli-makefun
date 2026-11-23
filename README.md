# mend-cli-makefun

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kidahajime-wq/mend-cli-makefun/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kidahajime-wq/mend-cli-makefun/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edit commands, applied to a tree of files with byte-exact output preservation — line endings, trailing line breaks, and indentation are kept as the files had them, and edits are matched at three fuzz tiers (exact, trailing whitespace, re-indented) with `--strict` for exact-only matching. Failed edits change nothing and never stop later edits; a patch that changes nothing reports `ok: 0 files`. See `SPEC.md` for the full contract.

## Run it

```sh
node main.ts [--format=unified|search_replace|v4a|json] [--check] [--strict] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=4wdzbnwz&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
