#!/usr/bin/env bash
# The bug agent's publish step: applies the triage and fix jobs' results to the
# issue and, for a fix, commits it and opens a draft pull request (#1192).
#
# The only code that holds the app's write token, and it runs none of the
# agent's code. It reads the two jobs' structured results and the fix job's
# patch, checks the patch against the limits the prompts state, and commits
# through GitHub's API, which signs the commit as the app.
#
# Every path ends with a label and one comment on the issue. A run that fails,
# times out or breaks a limit hands the issue to a person (`ready-for-human`)
# and says why; nothing is left labelled `ready-for-agent` without a PR.
#
# Environment: REPO, ISSUE, BASE_SHA, BASE_BRANCH, RUN_URL, GH_TOKEN,
# TRIAGE_RESULT, TRIAGE_JSON, FIX_RESULT, FIX_JSON, PATCH_FILE.
set -Eeuo pipefail

branch="bug-agent/${ISSUE}"
work="$(mktemp -d)"
footer=$'\n\n---\n'"Posted by the bug agent. [Workflow run](${RUN_URL})"

label() {
  gh issue edit "$ISSUE" --repo "$REPO" --add-label "$1" >/dev/null
  gh issue edit "$ISSUE" --repo "$REPO" --remove-label needs-triage >/dev/null 2>&1 || true
}

comment() {
  printf '%s%s\n' "$1" "$footer" >"$work/comment.md"
  gh issue comment "$ISSUE" --repo "$REPO" --body-file "$work/comment.md" >/dev/null
}

hand_over() {
  label ready-for-human
  comment "$1"
  exit 0
}

# A string field of a job's JSON result, or "" when the result is missing or
# malformed.
field() {
  printf '%s' "${1:-}" |
    jq -r --arg k "$2" 'if type == "object" then (.[$k] // "") else "" end' 2>/dev/null || true
}

# Triage.
[ "$TRIAGE_RESULT" = success ] ||
  hand_over "The bug agent could not finish triaging this issue, so it needs a person."

outcome="$(field "$TRIAGE_JSON" outcome)"
triage_comment="$(field "$TRIAGE_JSON" comment)"
case "$outcome" in
  needs-info | ready-for-human)
    label "$outcome"
    comment "$triage_comment"
    exit 0
    ;;
  ready-for-agent) ;;
  *) hand_over "The bug agent's triage returned no usable outcome, so this issue needs a person." ;;
esac

# Fix.
[ "$FIX_RESULT" = success ] ||
  hand_over "${triage_comment}"$'\n\n'"The bug agent's fix run did not finish: it failed, timed out or ran out of turns. This needs a person."

fix_comment="$(field "$FIX_JSON" comment)"
[ "$(field "$FIX_JSON" outcome)" = fixed ] || hand_over "$fix_comment"

subject="$(field "$FIX_JSON" commit_subject)"
[ -n "$subject" ] && [ -s "$PATCH_FILE" ] ||
  hand_over "${fix_comment}"$'\n\n'"The bug agent reported a fix but produced no commit subject or no changes, so this needs a person."

git apply --index "$PATCH_FILE" 2>"$work/apply.err" ||
  hand_over "${fix_comment}"$'\n\n'"The bug agent's changes did not apply to the base commit, so this needs a person."

# The limits, checked here rather than trusted to the prompt.
reasons=()
while IFS= read -r path; do
  case "$path" in
    .github/* | prisma/* | *.proto | package.json | */package.json | package-lock.json)
      reasons+=("- It changes \`$path\`, which the bug agent may not change.")
      ;;
  esac
done < <(git diff --cached --no-renames --name-only)

libs="$(git diff --cached --no-renames --name-only | sed -n 's#^libs/api/\([^/]*\)/.*#\1#p' | sort -u | wc -l | tr -d ' ')"
[ "$libs" -le 1 ] || reasons+=("- It changes $libs feature libs under \`libs/api/\`; the limit is one.")

lines="$(git diff --cached --no-renames --numstat | awk '
  $1 == "-" { next }
  $3 ~ /\.(spec|e2e-spec)\.ts$/ || $3 ~ /(^|\/)(__fixtures__|fixtures)\// { next }
  { n += $1 + $2 }
  END { print n + 0 }')"
[ "$lines" -le 100 ] || reasons+=("- It changes $lines lines outside test files; the limit is 100.")

if [ "${#reasons[@]}" -gt 0 ]; then
  hand_over "${fix_comment}"$'\n\n'"The bug agent wrote a fix, but it is outside what the agent may open a pull request for, so this needs a person:"$'\n\n'"$(printf '%s\n' "${reasons[@]}")"
fi

if gh api "repos/$REPO/git/ref/heads/$branch" >/dev/null 2>&1; then
  hand_over "${fix_comment}"$'\n\n'"A fix branch \`$branch\` already exists from an earlier run, so the bug agent left it alone. This needs a person."
fi

# From here a failure leaves a branch behind, so it is reported too.
trap 'label ready-for-human; comment "The bug agent created the branch \`'"$branch"'\` but could not finish opening a pull request, so this needs a person."' ERR

# The branch starts at the commit the fix was written against, not at the
# base branch's current tip, so the commit carries only the agent's changes.
# Anything merged since then shows in the pull request as a merge, not as a
# revert.
gh api "repos/$REPO/git/refs" -f ref="refs/heads/$branch" -f sha="$BASE_SHA" >/dev/null

: >"$work/additions.jsonl"
: >"$work/deletions.jsonl"
while IFS=$'\t' read -r status path; do
  if [ "$status" = D ]; then
    jq -nc --arg p "$path" '{path: $p}' >>"$work/deletions.jsonl"
  else
    jq -nc --arg p "$path" --rawfile c <(base64 <"$path" | tr -d '\n') '{path: $p, contents: $c}' >>"$work/additions.jsonl"
  fi
done < <(git diff --cached --no-renames --name-status)

jq -n \
  --arg repo "$REPO" \
  --arg branch "$branch" \
  --arg oid "$BASE_SHA" \
  --arg headline "$subject" \
  --arg body "$(field "$FIX_JSON" commit_body)" \
  --slurpfile add "$work/additions.jsonl" \
  --slurpfile del "$work/deletions.jsonl" \
  '{
    query: "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { url } } }",
    variables: { input: {
      branch: { repositoryNameWithOwner: $repo, branchName: $branch },
      expectedHeadOid: $oid,
      message: { headline: $headline, body: $body },
      fileChanges: { additions: $add, deletions: $del }
    } }
  }' >"$work/commit.json"

gh api graphql --input "$work/commit.json" >"$work/commit.out"
jq -e '.data.createCommitOnBranch.commit.url' "$work/commit.out" >/dev/null

{
  field "$FIX_JSON" pr_body
  printf '\nCloses #%s\n' "$ISSUE"
} >"$work/pr.md"

pr_url="$(gh pr create --repo "$REPO" --draft --base "$BASE_BRANCH" --head "$branch" \
  --title "$subject" --body-file "$work/pr.md")"

trap - ERR
label ready-for-agent
comment "${fix_comment}"$'\n\n'"Draft pull request: ${pr_url}"
