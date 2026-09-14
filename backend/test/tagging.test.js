// 打标决策层单元测试：不依赖模型与数据库，验证阈值/margin/top-k/待审兜底等纯逻辑。
// 重点覆盖「分数窄带」场景——这是 0.22~0.29 宽度内全局阈值调参失效的根因（见 docs/改进方案.md）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTags, applyMutex, calibrateThresholds, summaryStats } from '../src/tagging.js';

const c = (name, group, score, threshold = 0.25) => ({ name, group, score, threshold });

test('决策：空输入返回空', () => {
  assert.deepEqual(decideTags([]), { tags: [], review: [] });
  assert.deepEqual(decideTags(null), { tags: [], review: [] });
});

test('决策：每组最多 2 个，全图最多 4 个', () => {
  // 场景组 3 个都过阈值且彼此只差 0.01 → 只留 2 个
  const r = decideTags([
    c('室内', '场景', 0.30), c('室外', '场景', 0.29), c('家', '场景', 0.28),
    c('活动X', '活动', 0.27), c('活动Y', '活动', 0.26),
  ]);
  assert.equal(r.review.length, 0);
  assert.equal(r.tags.length, 4); // 2 + 2，全局上限
  assert.equal(r.tags[0].name, '室内'); // 按分数降序
});

test('决策：组内远离最高分的候选被相对 margin 丢弃', () => {
  const r = decideTags([
    c('室内', '场景', 0.30),
    c('室外', '场景', 0.27),   // 差 0.03 > 0.02 → 丢弃
    c('夜景', '场景', 0.265),  // 差 0.035 → 丢弃
  ]);
  assert.deepEqual(r.tags.map((t) => t.name), ['室内']);
});

test('决策：过阈值的候选不会被待审替换', () => {
  const r = decideTags([c('风景', '场景', 0.26), c('猫', '物品', 0.20)]);
  assert.equal(r.tags.length, 1);
  assert.equal(r.review.length, 0);
});

test('决策：全部低于阈值且最近的在窗口内 → 单个待审', () => {
  const r = decideTags([
    c('风景', '场景', 0.236),  // 距阈值 -0.014
    c('猫', '物品', 0.18),     // 距离远
  ]);
  assert.equal(r.tags.length, 0);
  assert.equal(r.review.length, 1);
  assert.equal(r.review[0].name, '风景');
});

test('决策：全部远低于阈值 → 不产出任何标签', () => {
  const r = decideTags([c('风景', '场景', 0.21), c('猫', '物品', 0.20)]);
  assert.deepEqual(r, { tags: [], review: [] });
});

test('决策：窄带防护——0.22~0.29 分数带在阈值 0.25 下产出合理数量', () => {
  // 模拟真实窄带：候选挤在 0.05 宽度里，部分过阈值（修复前：要么 0 个要么 10+ 个）
  const candidates = [];
  const scores = [0.256, 0.255, 0.254, 0.224, 0.223, 0.222, 0.221, 0.219, 0.218, 0.216,
    0.253, 0.252, 0.251, 0.249, 0.248, 0.247, 0.246, 0.245];
  scores.forEach((s, i) => candidates.push(c(`标签${i}`, i % 3 === 0 ? '场景' : '人', s)));
  const r = decideTags(candidates);
  // 过阈值者按组内 margin 限流：两组各留 ≤2，全局共 ≤4
  assert.equal(r.tags.length, 4);
  assert.ok(r.tags[0].score >= r.tags[3].score, '按分数降序');
  for (const t of r.tags) assert.ok(t.score >= 0.25, '确认标签必须过阈值');
});

test('决策：窄带防护——全部略低于阈值时进待审而非静默丢弃', () => {
  const candidates = [];
  for (let i = 0; i < 10; i++) candidates.push(c(`标签${i}`, '场景', 0.25 - 0.005 - i * 0.001));
  const r = decideTags(candidates);
  assert.equal(r.tags.length, 0);
  assert.equal(r.review.length, 1);
  assert.equal(r.review[0].name, '标签0'); // 距阈值最近的（0.245）
});

test('互斥：组内互斥候选只留最高分', () => {
  const group = [c('室内', '场景', 0.24), c('室外', '场景', 0.27), c('夜景', '场景', 0.30)];
  const out = applyMutex(group, ['室内', '室外']);
  assert.deepEqual(out.map((t) => t.name).sort(), ['夜景', '室外']);
  assert.equal(applyMutex(group, []).length, 3, '无互斥配置时原样返回');
});

test('校准：样本不足不产出，分位数被夹取到 [0.18, 0.32]', () => {
  const few = Array.from({ length: 10 }, (_, i) => ({ group: '场景', score: 0.2 + i * 0.01 }));
  assert.deepEqual(calibrateThresholds(few), {}, '样本 < 25 不推荐');
  const many = Array.from({ length: 100 }, (_, i) => ({ group: '场景', score: 0.10 + i * 0.01 })); // P60≈0.695 → 夹到 0.32
  const r = calibrateThresholds(many);
  assert.equal(r['场景'], 0.32);
  const low = Array.from({ length: 100 }, (_, i) => ({ group: '人', score: 0.10 + i * 0.0001 })); // P60≈0.106 → 夹到 0.18
  assert.equal(calibrateThresholds(low)['人'], 0.18);
});

test('统计：summaryStats 返回 min/p50/max', () => {
  assert.deepEqual(summaryStats([]), { min: null, p50: null, max: null, count: 0 });
  const s = summaryStats([0.25, 0.22, 0.29, 0.23, 0.28]);
  assert.equal(s.count, 5);
  assert.equal(s.min, 0.22);
  assert.equal(s.p50, 0.25);
  assert.equal(s.max, 0.29);
});
