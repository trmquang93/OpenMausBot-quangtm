[[ -o interactive ]] || return 0
(( ${+_omb_integrated} )) && return 0
typeset -g _omb_integrated=1 _omb_ran=0

_omb_preexec() {
  _omb_ran=1
  printf '\e]133;C\a'
}

_omb_precmd() {
  local code=$?
  if (( _omb_ran )); then
    printf '\e]133;D;%d\a' "$code"
    _omb_ran=0
  fi
  printf '\e]133;A\a'
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _omb_preexec
precmd_functions=(_omb_precmd ${precmd_functions:#_omb_precmd})
PS1="${PS1}%{"$'\e]133;B\a'"%}"
