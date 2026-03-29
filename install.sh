#!/usr/bin/env bash
set -e

# ── Detect shell profile ───────────────────────────────────────────────────────

detect_profile() {
  case "$SHELL" in
    */zsh)  echo "$HOME/.zshrc" ;;
    */bash) echo "$HOME/.bashrc" ;;
    *)      echo "$HOME/.profile" ;;
  esac
}

PROFILE=$(detect_profile)

# ── Install ────────────────────────────────────────────────────────────────────

echo "▶ Installing dependencies..."
npm install

echo "▶ Building..."
npm run build

echo "▶ Linking radar command..."
npm link

# ── Append env vars (idempotent) ───────────────────────────────────────────────

MARKER="# Radar: Claude Code OTel config"

if grep -qF "$MARKER" "$PROFILE" 2>/dev/null; then
  echo "✓ OTel env vars already present in $PROFILE — skipping."
else
  echo "" >> "$PROFILE"
  cat >> "$PROFILE" << 'EOF'
# Radar: Claude Code OTel config
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:4820/v1/logs
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_TOOL_DETAILS=1
export OTEL_LOGS_EXPORT_INTERVAL=2000
EOF
  echo "✓ OTel env vars written to $PROFILE"
fi

# ── Done ───────────────────────────────────────────────────────────────────────

echo ""
echo "✅ Radar installed. Run this to activate the env vars in your current shell:"
echo ""
echo "   source $PROFILE"
echo ""
echo "Then set your API key and start Radar:"
echo ""
echo "   export ANTHROPIC_API_KEY=sk-ant-..."
echo "   radar watch"
echo ""
