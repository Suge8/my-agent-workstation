# 由 ~/.zshrc 末尾 source。密钥放 ~/.config/my-agent-workstation/env.zsh，不入库。
export PI_CACHE_RETENTION=long
[[ -r "$HOME/.config/my-agent-workstation/env.zsh" ]] && source "$HOME/.config/my-agent-workstation/env.zsh"

[[ -o interactive ]] || return 0

HOMEBREW_PREFIX="${HOMEBREW_PREFIX:-$(brew --prefix)}"
ZSH_AUTOSUGGEST_STRATEGY=(history completion)
ZSH_AUTOSUGGEST_USE_ASYNC=1
ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=20
ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=242'
source "$HOMEBREW_PREFIX/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
eval "$(starship init zsh)"
# syntax-highlighting 必须在所有 zle widget（含 starship 定义的）之后加载
source "$HOMEBREW_PREFIX/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
# 只在顶层登录 shell 打印，避免子 shell 重复刷屏
[[ -o login ]] && command -v fastfetch >/dev/null && fastfetch
