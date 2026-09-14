<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  photo: Object, vocab: Array, sourceTags: Array, hasPrev: Boolean, hasNext: Boolean,
  reclassifying: Boolean, aiReclassifying: Boolean, aiReady: Boolean,
});
const emit = defineEmits(['close', 'prev', 'next', 'change', 'delete', 'reclassify', 'reclassify-ai', 'reset']);

const showPicker = ref(false);

// 「模型怎么看」：按需拉取该图 top5 候选分数（含未过阈值的），解释为什么打上/没打上某标签
const scoresOpen = ref(false);
const scores = ref(null);
const scoresLoading = ref(false);
async function toggleScores() {
  scoresOpen.value = !scoresOpen.value;
  if (scoresOpen.value && !scores.value) {
    scoresLoading.value = true;
    try { scores.value = await api.photoScores(props.photo.id); }
    catch (e) { scores.value = { error: e.message }; }
    finally { scoresLoading.value = false; }
  }
}
// 切换图片后清空调试缓存
watch(() => props.photo.id, () => { scores.value = null; scoresOpen.value = false; });

const allTags = computed(() => {
  const list = [];
  for (const g of props.vocab || []) {
    for (const name of g.tags) list.push({ name, group: g.name });
  }
  for (const t of props.sourceTags || []) list.push({ name: t.name, group: '来源目录' });
  return list;
});
const groupedTags = computed(() => {
  const m = {};
  for (const t of allTags.value) (m[t.group] = m[t.group] || []).push(t.name);
  return m;
});

const currentTags = computed(() => (props.photo?.tags || []).filter((t) => !t.rejected));

function tagClass(t) {
  if (t.source === 'manual') return 'man';
  if (t.source === 'vlm') return 'vlm';
  if (t.source === 'clip') return 'auto';
  return 'sys';
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function removeTag(name) { emit('change', [], [name]); }
function addTag(name) { emit('change', [name], []); }

// 原图浏览器解不了（如 HEIC）时退回缩略图
function onImgErr(e, id) {
  const el = e.target;
  if (!el.dataset.fb) { el.dataset.fb = '1'; el.src = api.thumb(id); }
}

function onKey(e) {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') emit('close');
  else if (e.key === 'ArrowLeft') emit('prev');
  else if (e.key === 'ArrowRight') emit('next');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="lb">
    <div class="pic">
      <img :src="api.file(photo.id)" @error="onImgErr($event, photo.id)" />
      <button v-if="hasPrev" class="nav prev" @click="emit('prev')">‹</button>
      <button v-if="hasNext" class="nav next" @click="emit('next')">›</button>
    </div>

    <div class="info">
      <div class="head">
        <span class="date">{{ fmtDate(photo.taken_at) }}</span>
        <button class="close" @click="emit('close')">✕</button>
      </div>
      <div class="path">{{ photo.path }}</div>
      <div class="meta">{{ photo.source_dir }} · {{ photo.width }}×{{ photo.height }}</div>

      <div class="h">自动标签（点 × 驳回）</div>
      <div class="taglist">
        <span v-for="t in currentTags.filter(x => x.source === 'clip' || x.source === 'vlm')" :key="t.name" class="chip auto" :class="{ low: t.confidence != null && t.confidence < 0.28, vlm: t.source === 'vlm' }" :title="(t.source === 'vlm' ? '🧠 AI 增强 · ' : '⚡ 本地模型 · ') + '置信 ' + (t.confidence != null ? Number(t.confidence).toFixed(2) : '-')">
          <span v-if="t.source === 'vlm'">🧠</span>{{ t.name }}<span v-if="t.confidence != null" class="sc">{{ Number(t.confidence).toFixed(2) }}</span><i @click.stop="removeTag(t.name)">×</i>
        </span>
        <span v-if="!currentTags.some(x => x.source === 'clip' || x.source === 'vlm')" class="none">无</span>
      </div>

      <div class="h">系统标签（规则，不能删）</div>
      <div class="taglist">
        <span v-for="t in currentTags.filter(x => x.source === 'rule' || x.source === 'exif')" :key="t.name" class="chip sys">{{ t.name }}</span>
        <span v-if="!currentTags.some(x => x.source === 'rule' || x.source === 'exif')" class="none">无</span>
      </div>

      <div class="h">我的标签（最高优先）</div>
      <div class="taglist">
        <span v-for="t in currentTags.filter(x => x.source === 'manual')" :key="t.name" class="chip man">{{ t.name }}<i @click.stop="removeTag(t.name)">×</i></span>
        <span v-if="!currentTags.some(x => x.source === 'manual')" class="none">无</span>
      </div>

      <div class="actions">
        <button class="primary" :disabled="reclassifying" @click="emit('reclassify')">{{ reclassifying ? '⏳ 分类中…' : '⚡ 本地重新分类' }}</button>
        <button v-if="aiReady" class="aibtn" :disabled="aiReclassifying" @click="emit('reclassify-ai')">
          {{ aiReclassifying ? '⏳ AI 复判中…' : '🧠 AI 增强复判' }}
        </button>
        <button class="primary" @click="showPicker = !showPicker">＋ 加标签</button>
        <button class="warn push" @click="emit('reset')">↩ 重置</button>
        <button class="danger" @click="emit('delete')">🗑 删除</button>
        <button @click="emit('close')" title="Esc">✕</button>
      </div>

      <!-- 模型分数调试条：展示 top5 候选与各自有效阈值 -->
      <div class="h">模型怎么看（可解释性）</div>
      <button class="sm" @click="toggleScores">{{ scoresOpen ? '收起模型分数' : (scoresLoading ? '⏳ 推理中…' : '📊 查看模型 top5 分数') }}</button>
      <div v-if="scoresOpen" class="scores">
        <div v-if="scores?.error" class="none">获取失败：{{ scores.error }}</div>
        <template v-else-if="scores">
          <div v-for="t in scores.top" :key="t.name" class="srow">
            <span class="sname">{{ t.name }}</span>
            <span class="sbar"><span class="sfill" :class="{ pass: t.score >= t.threshold }" :style="{ width: Math.min(100, Math.max(3, t.score * 250)) + '%' }" /></span>
            <span class="sscore" :class="{ pass: t.score >= t.threshold }">{{ t.score.toFixed(3) }}</span>
            <span class="sth" :title="'该标签有效阈值'">阈 {{ t.threshold.toFixed(2) }}</span>
          </div>
          <div v-if="!scores.top?.length" class="none">无候选分数</div>
          <div class="snote muted small">蓝=过阈值（确认），灰=未过阈值。全部未过且接近阈值时该图进入「待确认」。</div>
        </template>
      </div>

      <div v-if="showPicker" class="picker">
        <div v-for="(names, group) in groupedTags" :key="group" class="pgrp">
          <div class="pgname">{{ group }}</div>
          <div class="ptags">
            <button v-for="n in names" :key="n" class="ptag" :class="{ used: currentTags.some(t => t.name === n) }" @click="addTag(n)">{{ n }}</button>
          </div>
        </div>
      </div>

      <div v-if="photo.dupes?.length" class="h" style="margin-top:12px">疑似重复 {{ photo.dupes.length }} 张</div>
    </div>
  </div>
</template>

<style scoped>
.lb { flex: 1; display: grid; grid-template-columns: 1fr 320px; min-height: 0; }
.pic { background: #07090d; display: flex; align-items: center; justify-content: center; position: relative; min-width: 0; }
.pic img { max-width: 100%; max-height: 100%; object-fit: contain; }
.nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,.12); color: #fff; border: 0; width: 40px; height: 40px; border-radius: 50%; font-size: 18px; cursor: pointer; }
.nav:hover { background: rgba(255,255,255,.28); color: #fff; }
.nav.prev { left: 12px; } .nav.next { right: 12px; }

.info { background: var(--surface); padding: 16px; border-left: 1px solid var(--border); overflow-y: auto; min-width: 0; }
.head { display: flex; justify-content: space-between; align-items: center; }
.date { font-weight: 700; font-size: 15px; }
.close { background: none; border: none; font-size: 16px; color: var(--muted); cursor: pointer; padding: 4px 6px; }
.close:hover { color: var(--text); }
.path { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted-2); word-break: break-all; margin: 8px 0; background: var(--surface-2); padding: 6px 8px; border-radius: 6px; }
.meta { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.h { color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .05em; margin: 14px 0 7px; }
.taglist { display: flex; flex-wrap: wrap; gap: 5px; }
.none { color: var(--muted-2); font-size: 12px; }
.chip i { cursor: pointer; opacity: .6; font-style: normal; font-weight: 700; }
.chip i:hover { opacity: 1; }
.chip .sc { opacity: .6; font-size: 11px; }
.chip.auto.low { background: var(--warn-soft); color: var(--warn); }

button.aibtn { background: var(--vlm-soft); color: var(--vlm); border-color: rgba(167, 139, 250, .4); }
button.aibtn:hover { color: var(--vlm); border-color: var(--vlm); }

.actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; align-items: center; }
.actions .push { margin-left: auto; }
button.warn { background: var(--warn-soft); color: var(--warn); border-color: rgba(251, 191, 36, .35); }
button.warn:hover { color: var(--warn); border-color: var(--warn); }
.picker { margin-top: 12px; border-top: 1px solid var(--border-2); padding-top: 10px; }
.pgrp { margin-bottom: 8px; }
.pgname { font-size: 11px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
.ptags { display: flex; flex-wrap: wrap; gap: 5px; }
.ptag { font-size: 12px; padding: 4px 10px; }
.ptag.used { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-border); }

button.sm { padding: 4px 10px; font-size: 12px; }
.scores { margin-top: 8px; display: flex; flex-direction: column; gap: 5px; }
.srow { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.srow .sname { width: 64px; flex-shrink: 0; color: var(--text-2); text-align: right; }
.srow .sbar { flex: 1; height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; }
.srow .sfill { display: block; height: 100%; background: var(--border); border-radius: 4px; }
.srow .sfill.pass { background: var(--accent); }
.srow .sscore { width: 44px; color: var(--muted); font-family: ui-monospace, monospace; }
.srow .sscore.pass { color: var(--accent); font-weight: 600; }
.srow .sth { width: 52px; color: var(--muted-2); font-size: 11px; font-family: ui-monospace, monospace; }
.snote { margin-top: 2px; }
.muted { color: var(--muted); }
.small { font-size: 11px; }
</style>
