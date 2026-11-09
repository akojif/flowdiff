# Records docs/demo.gif. From the repo root, after `npm run build`:
#   vhs docs/demo.tape
# Uses made-up workflows (scripts/demo-repo.mjs) and git-ref mode: no n8n instance needed.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1500
Set Height 740
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type `export PS1='$ ' FLOWDIFF_BIN=$PWD/dist/cli.js && flowdiff() { node "$FLOWDIFF_BIN" "$@"; }`
Enter
Type "rm -rf /tmp/flowdiff-demo && node scripts/demo-repo.mjs /tmp/flowdiff-demo >/dev/null && cd /tmp/flowdiff-demo && clear"
Enter
Sleep 1s
# Run the first command while hidden, so the very first frame already shows its output.
Type "flowdiff diff main..feature"
Enter
Sleep 2s
Show

# Hold the detailed diff long enough to read.
Sleep 8s

# Clear while hidden, so each command starts at the top of a fresh screen.
Hide
Type "clear"
Enter
Show
Type "flowdiff diff main..feature --stat"
Sleep 400ms
Enter
Sleep 4s

Hide
Type "clear"
Enter
Show
Type `flowdiff diff main..feature --exit-code behavior > /dev/null; echo "exit code: $?"`
Sleep 400ms
Enter
Sleep 3s
