---
title: "日记"
# 日记不单独开列表页，入口只有 /navigator/
build:
  render: never
  list: never
# 日记之间不显示「上一篇 / 下一篇」
cascade:
  - target:
      kind: page
    params:
      hideNav: true
      dayReplies: true
---

按月份归档的日记。