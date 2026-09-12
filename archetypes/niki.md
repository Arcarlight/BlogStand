{{- /* 新建日记时的骨架。
       年月从文件名 niki_YYYYMM 里取；日历用短代码，构建时自动扫正文的
       <span id="MMDD"> 锚点生成（日记页和导航页共用一份）。 */ -}}
{{- $base := .File.ContentBaseName -}}
{{- $y := "" -}}
{{- $mo := "" -}}
{{- with findRESubmatch `(\d{4})(\d{2})` $base -}}
  {{- $y = index (index . 0) 1 -}}
  {{- $mo = index (index . 0) 2 | strings.TrimLeft "0" -}}
{{- end -}}
{{- $mo = $mo | default "1" -}}
---
title: "{{ with $y }}{{ . }}年{{ end }}{{ $mo }}月日记"
date: {{ with $y }}{{ . }}-{{ printf "%02d" (int $mo) }}-01T00:00:00+08:00{{ else }}{{ .Date }}{{ end }}
draft: false
description: ""
---
{{ with $y }}
<center>
{{ . }}年 {{ $mo }}月
</center>
{{ end }}{{ "{{< niki-cal >}}" }}
<br>
<hr />

<h2><span id="{{ printf "%02d" (int $mo) }}01">{{ $mo }}月 1日</span></h2>

在这里写这一天的事。

<!--more-->
