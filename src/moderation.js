// 违禁 / 违规词审查：开发者面板用来快速定位需要人工复核的内容。
// 词表按类别分组，保持笼统，只作为人工审查的辅助，不作为唯一判定依据。
const BANNED_WORDS = [
  // 赌博与诈骗
  '赌博', '博彩', '洗钱', '诈骗', '传销', '刷单', '高利贷',
  // 毒品与管制物品
  '毒品', '吸毒', '冰毒', '海洛因', '大麻', '摇头丸',
  // 暴力与自伤
  '肢解', '分尸', '虐杀', '碎尸', '自杀', '自残',
  // 色情与低俗
  '色情', '裸照', '约炮', '一夜情', '嫖娼',
  // 违法交易
  '代开发票', '办假证', '枪支', '弹药', '爆炸物', '迷药',
  // 个人信息与黑产
  '身份证号', '银行卡号', '开房记录', '人肉搜索',
  // 恐怖与极端
  '恐怖袭击', '爆炸袭击', '极端主义', '煽动仇恨'
];

export const MODERATION_VERSION = 1;

// 返回命中的词（去重），空数组表示没有命中
export function scanText(value) {
  const text = String(value || '');
  if (!text) return [];
  const hits = [];
  for (const w of BANNED_WORDS) {
    if (text.includes(w) && !hits.includes(w)) hits.push(w);
  }
  return hits;
}

export function moderationMeta() {
  return { version: MODERATION_VERSION, words: BANNED_WORDS.length };
}
