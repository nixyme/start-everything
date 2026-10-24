SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )" && cd "$SCRIPT_DIR"
set -euo pipefail
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi
python3 check_config.py
exec node node_modules/@tauri-apps/cli/tauri.js dev "$@"
