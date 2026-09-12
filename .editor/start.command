#!/bin/sh
# ============================================================
#  星虹巢 · 本地编辑器 —— macOS / Linux 启动脚本
#
#  macOS：在访达里双击这个文件就能跑（或者终端里 ./start.command）
#  Linux：./start.command  或  sh .editor/start.command
#
#  为什么开头要手动补 PATH：
#  访达双击 .command 时拿到的是「最小 PATH」（大致只有 /usr/bin:/bin:/usr/sbin:/sbin），
#  里面没有 Homebrew 装的 node / hugo，会直接 command not found。
#  所以这里把常见安装位置都补进去。nvm / fnm / volta 装的 node 也在列表里。
#
#  ⚠️ 这个文件必须保持 LF 换行（CRLF 会让 sh 报 "\r: command not found"）。
#     .gitattributes 里已经写了 *.command text eol=lf 兜着。
# ============================================================

cd "$(dirname "$0")/.." || exit 1

for d in /opt/homebrew/bin /usr/local/bin /opt/local/bin "$HOME/.volta/bin" "$HOME/.bun/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
for d in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/fnm/node-versions/*/installation/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH

die() {
  echo ""
  echo "  $1"
  echo ""
  printf "  按回车关闭窗口…"
  read -r _ 2>/dev/null || true
  exit 1
}

command -v node >/dev/null 2>&1 || die "找不到 node。装一个再回来：brew install node"

if command -v hugo >/dev/null 2>&1; then
  echo "  node $(node -v)　hugo $(hugo version 2>/dev/null | cut -d' ' -f2)"
else
  echo "  node $(node -v)"
  echo ""
  echo "  提示：没找到 hugo，编辑器能正常用，但预览 / 构建 / 发布会用不了。"
  echo "  装一个：brew install hugo"
fi
echo ""

node .editor/server.mjs

echo ""
printf "  编辑器已停止，按回车关闭窗口…"
read -r _ 2>/dev/null || true
