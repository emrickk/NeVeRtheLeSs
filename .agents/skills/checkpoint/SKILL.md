---
name: checkpoint
description: Save or restore file-level checkpoints of this repo. Use before any risky operation (mass content rewrites, merges, running unfamiliar scripts) and to revert bad changes without touching git history.
---

# Checkpoints

Snapshots of the entire working tree (tracked and untracked files, `.gitignore` respected) stored as hidden local git refs. They never appear in `git status` or `git log`, are never pushed, and restoring never moves HEAD or any branch: it only makes files match the snapshot.

## Commands

| Command | Effect |
| --- | --- |
| `npm run checkpoint save [label]` | Snapshot now (no-op if nothing changed) |
| `npm run checkpoint list` | Show checkpoints, newest first, with drift vs current files |
| `node scripts/checkpoint.mjs diff <id>` | What changed since the checkpoint (`--full` for the patch) |
| `node scripts/checkpoint.mjs restore <id> --yes` | Make all files match the snapshot |
| `node scripts/checkpoint.mjs restore <id> --yes -- <path>` | Restore only the named paths |

`<id>` is any unique substring of an id from `list`. For `diff` and `restore`, invoke the script with `node` directly as shown: plain `npm run checkpoint restore <id> --yes` does NOT work because npm swallows `--yes` and the first `--`, which can silently turn a partial restore into a full one. (`npm run checkpoint -- restore <id> --yes -- <path>` also works.)

## Rules for agents

1. Save a checkpoint (with a descriptive label) before: mass rewrites of posts, merges, dependency upgrades, or running any script that edits many files.
2. A full restore deletes files created after the snapshot. Restore always saves a `pre-restore` checkpoint first, so a mistaken restore is itself undoable: `node scripts/checkpoint.mjs restore <pre-restore-id> --yes`.
3. Restores are refused mid-merge/rebase. Finish or abort that operation first.
4. Every release check saves a checkpoint. `.claude/settings.json` also defines a Claude SessionStart hook; do not assume another agent host ran it. Check or save an explicit checkpoint when needed. Do not rely on automatic snapshots for labeled save points.
