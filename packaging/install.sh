#!/usr/bin/env bash
# Manual install straight from GitHub, no npm and no Homebrew.
#   curl -fsSL https://raw.githubusercontent.com/BardiaN/kronk-cli/main/packaging/install.sh | bash
set -euo pipefail

REPO="${KRONK_CLI_REPO:-BardiaN/kronk-cli}"
VERSION="${KRONK_CLI_VERSION:-latest}"
PREFIX="${KRONK_CLI_PREFIX:-$HOME/.local}"
LIB="$PREFIX/lib/kronk-cli"
BIN="$PREFIX/bin"

command -v node >/dev/null || { echo "node 20+ is required"; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || { echo "node 20+ is required (found $(node -v))"; exit 1; }

if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')"
  [ -n "$VERSION" ] || { echo "could not resolve the latest release"; exit 1; }
fi

echo "installing kronk-cli $VERSION -> $LIB"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz" | tar xz -C "$tmp" --strip-components=1

rm -rf "$LIB"
mkdir -p "$LIB" "$BIN"
cp -R "$tmp/src" "$tmp/package.json" "$LIB/"

cat > "$BIN/kronk-cli" <<SH
#!/usr/bin/env bash
exec node "$LIB/src/index.js" "\$@"
SH
chmod +x "$BIN/kronk-cli"

echo "installed: $BIN/kronk-cli"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "note: add $BIN to your PATH" ;;
esac
