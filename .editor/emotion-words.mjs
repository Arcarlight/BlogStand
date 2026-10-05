/* ============================================================
   「蒂安希听到了」—— 关键词 -> 表情 的判定表
   ------------------------------------------------------------
   站长写的话存在 data/diancie-heard.toml。每条可以自己指定表情（emotion
   字段）；留空就把那句话丢进这里，命中**第一个**关键词就用那个表情，
   一个都没命中 = Normal（平静）。

   所以下面 EMOTION_WORDS 的**顺序就是优先级**，越靠前越优先。为什么这个
   顺序不能随手重排：中文短语会互相吃（「大哭」里同时有「哭」和「大声」
   这类情况），谁先被扫到就归谁；排错了表现是「明明选了哭脸，页面上却是
   笑脸」这种没法一眼看穿的错。

   ⚠️ 这份表必须和 static/js/diancie-heard.js 里的 EMOTION_WORDS **逐条一致**
      （条数、顺序、每个词都要一致）：
        · 页面上真正显示哪张脸 = static/js/diancie-heard.js 那份算的
        · 编辑器面板的「自动 → X」预览 = 这份算的
      少同步一处，面板上预览出来的表情就和页面上的不一样 —— 那比没有预览
      更糟（站长会照着预览去调，结果怎么调都不对）。

   注意「泪」在 Crying 里而 Crying 排在 Teary-Eyed 前面：所以「含泪」会被
   Crying 接住，只有「眼眶」「差点掉下」才会判成 Teary-Eyed。这是客户端那份
   的既有行为，这里照抄 —— 想让「含泪」归 Teary-Eyed 就得两边一起把
   Teary-Eyed 挪到 Crying 前面，别只改一处。
   ============================================================ */

export const EMOTION_WORDS = [
  ['Crying',      ['哭', '泪', '呜呜', '抽泣', '哽咽']],
  ['Sad',         ['难过', '伤心', '低落', '失落', '寂寞', '孤单', '遗憾', '舍不得', '断了']],
  ['Angry',       ['生气', '气死', '愤怒', '讨厌', '可恶', '烦人']],
  ['Surprised',   ['吃惊', '惊讶', '居然', '竟然', '没想到', '吓了一跳', '有人来']],
  ['Worried',     ['担心', '不安', '放心不下', '有事', '危险', '等它', '一直在等']],
  ['Sigh',        ['叹气', '叹了', '唉', '无奈', '算了']],
  ['Teary-Eyed',  ['眼眶', '含泪', '差点掉下']],
  ['Shouting',    ['大声', '喊', '吼', '叫了']],
  ['Pain',        ['疼', '痛', '受伤']],
  ['Dizzy',       ['晕', '天旋地转', '晃']],
  ['Stunned',     ['愣', '呆住', '说不出话']],
  ['Joyous',      ['雀跃', '跳起来', '太好了', '真好', '欢呼']],
  ['Happy',       ['开心', '高兴', '愉快', '笑', '喜欢', '好看', '温柔', '暖']],
  ['Inspired',    ['想法', '灵感', '启发', '有意思', '像一小片', '很像']],
  ['Determined',  ['一定', '决定', '坚持', '继续', '不会停']],
];

/* 16 个表情名，顺序固定：就是 data/diancie-heard.toml 抬头里列的那一套
   （Normal 也在其中；上面那张表里没有 Normal，它是「都没命中」的兜底）。
   接口返回的 emotions、面板的下拉框、写盘时的白名单都用它。 */
export const EMOTION_NAMES = [
  'Normal', 'Happy', 'Joyous', 'Inspired', 'Determined', 'Angry', 'Sad', 'Crying',
  'Teary-Eyed', 'Worried', 'Sigh', 'Shouting', 'Surprised', 'Stunned', 'Dizzy', 'Pain',
];

/** 按关键词猜表情。命中第一个就返回；一个都没命中返回 'Normal'。 */
export function classifyEmotion(text) {
  const s = String(text ?? '');
  for (const [name, words] of EMOTION_WORDS) {
    for (const w of words) {
      if (s.includes(w)) return name;
    }
  }
  return 'Normal';
}
