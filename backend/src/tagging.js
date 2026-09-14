// 打标决策纯逻辑：输入候选分数，输出确认标签与待审标签。
// 与 DB / 模型完全解耦，便于单元测试（backend/test/tagging.test.js）。
//
// 背景：CLIP B/32 + 本流水线的 cosine 分数挤在 0.20~0.29 窄带内，
// 单一全局固定阈值会同时产生大量误标（阈值低）和大量漏标（阈值高）。
// 因此决策不再依赖单一阈值，而是组合：每组分数上限、组内相对差距、
// 全局总数上限，以及「距阈值很近时进待审而非丢弃」的兜底。

export const DECIDE_DEFAULTS = {
  perGroupCap: 2,      // 每组最多保留标签数
  globalCap: 4,        // 每张图标签总数上限
  relativeMargin: 0.02, // 组内候选与最高分差距超过该值则丢弃
  reviewWindow: 0.03   // 低于阈值但在该窗口内 → 进待审而非丢弃
};

/**
 * @param {Array<{name:string, group:string, score:number, threshold:number}>} candidates
 * @param {{perGroupCap?:number, globalCap?:number, relativeMargin?:number, reviewWindow?:number}} opts
 * @returns {{tags: Array, review: Array}} tags=确认标签；review=待审标签（0 或 1 个）
 */
export function decideTags(candidates, opts = {}) {
  const { perGroupCap, globalCap, relativeMargin, reviewWindow } = { ...DECIDE_DEFAULTS, ...opts };
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && Number.isFinite(c.score)) : [];
  if (!list.length) return { tags: [], review: [] };

  // 分组
  const byGroup = new Map();
  for (const c of list) {
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group).push(c);
  }

  // 组内：过阈值者按分数降序，只留与组内最高分相差 ≤ relativeMargin 的前 perGroupCap 个
  const confirmed = [];
  for (const groupList of byGroup.values()) {
    const pass = groupList.filter((c) => c.score >= c.threshold).sort((a, b) => b.score - a.score);
    if (!pass.length) continue;
    const top = pass[0].score;
    confirmed.push(...pass.filter((c) => top - c.score <= relativeMargin).slice(0, perGroupCap));
  }

  // 跨组按分数排序并限制全图总数
  confirmed.sort((a, b) => b.score - a.score);
  const tags = confirmed.slice(0, globalCap);
  if (tags.length) return { tags, review: [] };

  // 兜底：全部低于阈值 → 取「score - threshold」最大者，若在待审窗口内则标记待审
  let best = null;
  for (const c of list) {
    const gap = c.score - c.threshold;
    if (!best || gap > best.gap) best = { ...c, gap };
  }
  if (best && best.gap >= -reviewWindow) {
    return { tags: [], review: [{ name: best.name, group: best.group, score: best.score }] };
  }
  return { tags: [], review: [] };
}

/**
 * 互斥组过滤：组内属于 mutex 集合的候选只保留最高分那个（在构建候选阶段调用）。
 * @param {Array} groupCandidates 同一组的候选
 * @param {string[]} mutexNames
 */
export function applyMutex(groupCandidates, mutexNames) {
  const mutex = new Set(mutexNames || []);
  if (!mutex.size) return groupCandidates;
  const inside = groupCandidates.filter((c) => mutex.has(c.name));
  if (inside.length < 2) return groupCandidates;
  const best = inside.reduce((a, b) => (a.score >= b.score ? a : b));
  return groupCandidates.filter((c) => !mutex.has(c.name) || c === best);
}

/**
 * 按各组的「每图最高分」样本自动推荐每组阈值（分位数 + 夹取）。
 * 样本数不足 minSamples 的组不产出（避免小样本噪声，也避免测试环境误写配置）。
 * @param {Array<{group:string, score:number}>} samples
 */
export function calibrateThresholds(samples, { minSamples = 25, percentile = 0.6, min = 0.18, max = 0.32 } = {}) {
  const byGroup = new Map();
  for (const s of samples || []) {
    if (!s || !Number.isFinite(s.score)) continue;
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(s.score);
  }
  const out = {};
  for (const [group, arr] of byGroup) {
    if (arr.length < minSamples) continue;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(percentile * sorted.length));
    out[group] = Math.round(Math.min(max, Math.max(min, sorted[idx])) * 1000) / 1000;
  }
  return out;
}

/** 分数分布摘要（min / p50 / max） */
export function summaryStats(values) {
  const arr = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return { min: null, p50: null, max: null, count: 0 };
  return {
    min: arr[0],
    p50: arr[Math.floor((arr.length - 1) / 2)],
    max: arr[arr.length - 1],
    count: arr.length,
  };
}
