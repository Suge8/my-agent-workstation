# 由 ~/.zshrc 末尾 source。密钥放 ~/.config/my-agent-workstation/env.zsh，不入库。
export PI_CACHE_RETENTION=long
[[ -r "$HOME/.config/my-agent-workstation/env.zsh" ]] && source "$HOME/.config/my-agent-workstation/env.zsh"

[[ -o interactive ]] || return 0

# UU 远程的「终端」跑在 UU 自带的 tmux 里，而 UU 客户端不带 COLORTERM，tmux 就把 24 位色压成 256 色。
# 在 UU 会话内给这个 tmux 声明真彩色；终端特性在客户端接入时读取，所以从下一次连接起生效。
if [[ -n $UUYC_IN_MUX ]]; then
  export COLORTERM=truecolor
  uu_mux=(/Applications/UURemote.app/Contents/Helpers/tmux/uuyc-mux -S "$HOME/Library/Application Support/UURemote/tmux.sock")
  [[ $($uu_mux show -sv terminal-features) == *tmux-256color:RGB* ]] || $uu_mux set -as terminal-features tmux-256color:RGB
  unset uu_mux
fi

HOMEBREW_PREFIX="${HOMEBREW_PREFIX:-$(brew --prefix)}"
ZSH_AUTOSUGGEST_STRATEGY=(history completion)
ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=20
ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=8'
source "$HOMEBREW_PREFIX/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
eval "$(starship init zsh)"
# syntax-highlighting 必须在所有 zle widget（含 starship 定义的）之后加载
source "$HOMEBREW_PREFIX/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
# 只在登录 shell 打印（Herdr 面板在 macOS 上也是登录 shell），子 shell 不重复刷屏
[[ -o login ]] && command -v fastfetch >/dev/null && fastfetch
