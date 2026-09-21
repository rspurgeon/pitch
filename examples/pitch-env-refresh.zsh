# Source this file from your shell setup. Refreshes this shell, without restarting it.
pitch-env-refresh() {
  local name="${1:-${PITCH_WORKSPACE_NAME:-}}"
  if [[ -z "$name" ]]; then
    print -u2 'Usage: pitch-env-refresh <workspace>'
    return 1
  fi
  local environment_file
  environment_file=$(pitch refresh "$name") || return
  source "$environment_file"
}
