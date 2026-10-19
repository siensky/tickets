#!/usr/bin/env sh
# Runs gitleaks against staged changes. If gitleaks isn't installed on this
# machine, warn loudly instead of silently skipping the check (see
# docs/plan.md "Att ordna parallellt med fas 0" for install instructions).
set -e

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks protect --staged --redact -v
else
  echo ""
  echo "⚠️  gitleaks is not installed — secret scanning is SKIPPED for this commit."
  echo "   Install it (brew install gitleaks) so this check actually protects you."
  echo ""
fi
