#!/bin/bash
# ============================================================
#  星虹巢 · 本地编辑器 —— 生成一个 macOS 应用（双击即开）
#
#  用法：
#    tools/make-macos-app.sh                 # 装到 /Applications
#    tools/make-macos-app.sh ~/Applications  # 装到别处
#    tools/make-macos-app.sh /Applications 4322        # 换端口
#    tools/make-macos-app.sh /Applications 4321 某张图.png   # 换图标
#
#  它做的事：把下面那段启动逻辑写进
#      <目标>/星虹巢编辑器.app/Contents/MacOS/launcher
#  再配一份 Info.plist 和图标。
#
#  图标默认用 static/images/Hutsuu_flygon.PNG（1237×1237 的沙漠蜻蜓插画）——
#  站上那个 ico（images/migrated/Webpic.png）只有 64×64，放大到程序坞会糊。
#  想换：第三个参数传一张**方形、越大越好**的 PNG（512 以上最理想）。
#
#  ⚠️ 仓库路径是**生成时写死**的（应用要知道去哪找仓库）。仓库搬家/改名之后，
#     重跑一次这个脚本即可；应用自己发现路径不对时也会弹窗告诉你。
#
#  ⚠️ 这个应用不是签名的（本地自己用不需要）。第一次双击如果系统拦下来，
#     右键 → 打开，选一次「打开」就行。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="星虹巢编辑器"
DEST_DIR="${1:-/Applications}"
PORT="${2:-4321}"
ICON_SRC="${3:-$ROOT/static/images/Hutsuu_flygon.PNG}"
APP="$DEST_DIR/$APP_NAME.app"

[ -d "$ROOT/.editor" ] || { echo "找不到 .editor/ —— 这个脚本要放在仓库的 tools/ 里运行"; exit 1; }
[ -f "$ICON_SRC" ] || { echo "找不到图标素材：$ICON_SRC"; exit 1; }

echo "仓库：$ROOT"
echo "图标：$ICON_SRC"
echo "生成：$APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ---------- 启动器 ----------
cat > "$APP/Contents/MacOS/launcher" <<LAUNCHER
#!/bin/bash
# 星虹巢 · 本地编辑器 —— 应用外壳（由 tools/make-macos-app.sh 生成，别手改）
#
# 双击 = 启动编辑器并打开浏览器；已经在跑就只打开页面；
# 再点一次可以在弹窗里选「关掉编辑器」。
#
# 环境变量（一般用不到，排查时有用）：
#   EDITOR_NO_BROWSER=1     不打开浏览器
#   EDITOR_NO_DIALOG=1      不弹窗（直接当作「打开页面」）
#   EDITOR_LAUNCH_ACTION=stop   直接停掉编辑器
set -u

REPO="$ROOT"
PORT="$PORT"
LOG="\$REPO/.editor/editor.log"
URL="http://127.0.0.1:\$PORT/"

# Finder 双击时拿到的是「最小 PATH」，没有 Homebrew 装的 node / hugo
for d in /opt/homebrew/bin /usr/local/bin /opt/local/bin "\$HOME/.volta/bin" "\$HOME/.bun/bin"; do
  [ -d "\$d" ] && PATH="\$d:\$PATH"
done
for d in "\$HOME"/.nvm/versions/node/*/bin "\$HOME"/.local/share/fnm/node-versions/*/installation/bin; do
  [ -d "\$d" ] && PATH="\$d:\$PATH"
done
export PATH

# 弹个窗（文字用 argv 传进去，免得路径里的引号把 AppleScript 弄坏）
alert() {
  /usr/bin/osascript - "\$1" <<'AS' >/dev/null 2>&1 || true
on run argv
  display dialog (item 1 of argv) with title "星虹巢编辑器" buttons {"好"} default button 1 with icon caution
end run
AS
}

fail() {
  alert "\$1

\$(tail -n 12 "\$LOG" 2>/dev/null)"
  exit 1
}

alive() {
  /usr/bin/curl -sS -m 2 "http://127.0.0.1:\$PORT/api/ping" 2>/dev/null | grep -q hoshi-editor
}

open_page() {
  [ "\${EDITOR_NO_BROWSER:-}" = "1" ] || /usr/bin/open "\$URL"
}

stop_editor() {
  pids="\$(/usr/sbin/lsof -t -iTCP:\$PORT -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "\$pids" ] && kill \$pids 2>/dev/null || true
  # 顺带收掉可能还在的重启循环（它没有端口，lsof 找不到）
  /usr/bin/pkill -f "node .editor/server.mjs" 2>/dev/null || true
}

[ -d "\$REPO" ] || fail "找不到仓库目录：\$REPO
仓库被移动或改名了吧？在仓库里重新跑一次 tools/make-macos-app.sh 就好。"

if alive; then
  if [ "\${EDITOR_LAUNCH_ACTION:-}" = "stop" ]; then stop_editor; exit 0; fi
  if [ "\${EDITOR_NO_DIALOG:-}" = "1" ]; then open_page; exit 0; fi
  choice="\$(/usr/bin/osascript - <<'AS' 2>/dev/null || true
display dialog "编辑器已经在运行了。" with title "星虹巢编辑器" buttons {"取消", "关掉编辑器", "打开页面"} default button "打开页面"
AS
)"
  case "\$choice" in
    *关掉*) stop_editor ;;
    *打开*) open_page ;;
    *) : ;;
  esac
  exit 0
fi

# ------------------------------------------------------------
#  没在跑 → 交给「终端」去启动
#
#  为什么不在这里直接跑：这个应用是访达启动的**未签名脚本外壳**，macOS 的
#  隐私保护会**静默**拒掉它对 ~/文稿（仓库所在）的读写 —— 表现就是
#  「编辑器没能起来」而日志一行都没写（2026-10-08 踩的，找了半天）。
#  终端是系统签名应用、有自己的授权；不够时系统会弹一个看得懂的提示。
#  顺带的好处：编辑器跑在终端窗口里，关掉窗口就是停止（和以前一样）。
# ------------------------------------------------------------
APP_LOG="\$HOME/Library/Logs/星虹巢编辑器.log"
log() { printf '%s  %s\n' "\$(date '+%Y-%m-%d %H:%M:%S')" "\$1" >> "\$APP_LOG" 2>/dev/null || true; }

[ -x "\$REPO/.editor/start.command" ] || fail "找不到 \$REPO/.editor/start.command —— 仓库不完整，或者路径不对。"

log "启动：通过终端打开 \$REPO/.editor/start.command"
if ! /usr/bin/open -a Terminal "\$REPO/.editor/start.command" 2>/dev/null; then
  log "open -a Terminal 失败"
  fail "没能把启动命令交给「终端」。
可以手动打开：\$REPO/.editor/start.command"
fi

for _ in \$(seq 1 80); do        # 最多等 40 秒
  sleep 0.5
  alive && break
done

if alive; then
  log "起来了：\$URL"
  open_page
  exit 0
fi

log "超时：端口 \$PORT 没起来"
alert "编辑器还没起来（等了 40 秒）。

最可能的原因：macOS 拦住了「终端」对「文稿」文件夹的访问。
去「系统设置 → 隐私与安全性 → 文件与文件夹」里，允许「终端」
访问「文稿」文件夹；或者直接在终端里跑一次：

  \$REPO/.editor/start.command

就能看到真正的报错。

（这个应用自己的记录在 ~/Library/Logs/星虹巢编辑器.log）"
exit 1
LAUNCHER
chmod +x "$APP/Contents/MacOS/launcher"

# ---------- Info.plist ----------
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>星虹巢编辑器</string>
  <key>CFBundleDisplayName</key><string>星虹巢编辑器</string>
  <key>CFBundleIdentifier</key><string>local.hoshi.editor</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# ---------- 图标 ----------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z "$((s * 2))" "$((s * 2))" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"

plutil -lint "$APP/Contents/Info.plist" >/dev/null
touch "$APP"

echo ""
echo "好了。双击打开：$APP"
echo "（也可以拖进程序坞。想换图标：tools/make-macos-app.sh $DEST_DIR $PORT 另一张方形大图.png）"
