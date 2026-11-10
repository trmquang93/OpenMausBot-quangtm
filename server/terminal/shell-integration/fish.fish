status is-interactive; or return 0
set -q _omb_integrated; and return 0
set -g _omb_integrated 1

function _omb_preexec --on-event fish_preexec
    printf '\e]133;C\a'
end

function _omb_postexec --on-event fish_postexec
    printf '\e]133;D;%s\a' $status
end

function _omb_prompt --on-event fish_prompt
    printf '\e]133;A\a'
end
