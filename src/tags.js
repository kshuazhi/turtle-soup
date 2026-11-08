// 修复已知问题 / Fix known issues
// 非白名单标签在入库 / 加载时会被直接丢弃（留空），不会污染标签栏。
export const STORY_TAGS = ['经典', '悬疑', '恐怖', '悲伤', '温暖', '轻松', '推理', '脑洞', '科幻', '日常'];

const TAG_SET = new Set(STORY_TAGS);
export const MAX_TAGS_PER_STORY = 2;

export function normalizeTags(input, max = MAX_TAGS_PER_STORY) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (out.length >= max) break;
    if (typeof raw !== 'string') continue;
    const tag = raw.trim();
    if (!TAG_SET.has(tag) || out.includes(tag)) continue;
    out.push(tag);
  }
  return out;
}
