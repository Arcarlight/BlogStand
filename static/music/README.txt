把音频文件放进这个文件夹（mp3 / ogg / m4a 都行），
然后在 data/music.toml 里加一条 [[tracks]]：

  [[tracks]]
    file = "歌的文件名.mp3"
    title = "显示的名字"
    artist = "作者"

细节见 .notes/使用与维护.md 的「音乐播放器」一节。
