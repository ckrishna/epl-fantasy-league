#!/usr/bin/env bash
# Closes #7 (Redesign Stats page with split-pane AI assistant layout) -- shipped.
# Uses --body-file instead of an inline heredoc (the previous script,
# close_stale_genbi_issues.sh, hit a shell parsing error on the heredoc pattern
# partway through -- #38 closed fine, #7 likely didn't run).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

gh issue comment 7 --body-file "$SCRIPT_DIR/issue-comments/comment-7.md"
gh issue close 7

echo "Done. Run 'gh issue view 7' to confirm."
