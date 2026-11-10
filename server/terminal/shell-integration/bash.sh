[[ $- == *i* ]] || return 0
[[ -n ${_omb_integrated:-} ]] && return 0
_omb_integrated=1
_omb_ran=0
_omb_armed=0

_omb_prompt() {
  local code=$?
  if [[ $_omb_ran == 1 ]]; then
    printf '\e]133;D;%d\a' "$code"
    _omb_ran=0
  fi
  printf '\e]133;A\a'
}

_omb_arm() {
  _omb_armed=1
}

_omb_debug() {
  if [[ $_omb_armed == 1 ]]; then
    _omb_armed=0
    _omb_ran=1
    printf '\e]133;C\a'
  fi
}

trap '_omb_debug' DEBUG
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(_omb_prompt "${PROMPT_COMMAND[@]}" _omb_arm)
else
  PROMPT_COMMAND="_omb_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND};_omb_arm"
fi
PS1="${PS1}\[\e]133;B\a\]"
