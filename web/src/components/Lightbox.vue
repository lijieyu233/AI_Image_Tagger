<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  photo: Object, vocab: Array, sourceTags: Array, hasPrev: Boolean, hasNext: Boolean,
});
const emit = defineEmits(['close', 'prev', 'next', 'change']);

const showPicker = ref(false);

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
      <img :src="api.file(photo.id)" />
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
        <span v-for="t in currentTags.filter(x => x.source === 'clip')" :key="t.name" class="chip auto" :title="'置信 ' + (t.confidence != null ? Number(t.confidence).toFixed(2) : '-')">
          {{ t.name }}<span v-if="t.confidence != null" class="sc">{{ Number(t.confidence).toFixed(2) }}</span><i @click.stop="removeTag(t.name)">×</i>
        </span>
        <span v-if="!currentTags.some(x => x.source === 'clip')" class="none">无</span>
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
        <button class="primary" @click="showPicker = !showPicker">＋ 从词表添加</button>
        <button @click="emit('close')">返回网格</button>
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
.lb { flex: 1; display: grid; grid-template-columns: 1fr 300px; min-height: 0; }
.pic { background: #111827; display: flex; align-items: center; justify-content: center; position: relative; min-width: 0; }
.pic img { max-width: 100%; max-height: 100%; object-fit: contain; }
.nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,.15); color: #fff; border: 0; width: 38px; height: 38px; border-radius: 50%; font-size: 18px; cursor: pointer; }
.nav:hover { background: rgba(255,255,255,.3); }
.nav.prev { left: 12px; } .nav.next { right: 12px; }

.info { background: #fff; padding: 16px; border-left: 1px solid var(--border); overflow-y: auto; min-width: 0; }
.head { display: flex; justify-content: space-between; align-items: center; }
.date { font-weight: 700; font-size: 15px; }
.close { background: none; border: none; font-size: 16px; color: var(--muted); cursor: pointer; padding: 4px 6px; }
.path { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted-2); word-break: break-all; margin: 8px 0; background: var(--surface-2); padding: 6px 8px; border-radius: 6px; }
.meta { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.h { color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .05em; margin: 14px 0 7px; }
.taglist { display: flex; flex-wrap: wrap; gap: 5px; }
.none { color: var(--muted-2); font-size: 12px; }
.chip { display: inline-flex; gap: 5px; align-items: center; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 500; }
.chip i { cursor: pointer; opacity: .6; font-style: normal; font-weight: 700; }
.chip i:hover { opacity: 1; }
.chip .sc { opacity: .6; font-size: 11px; }
.chip.auto { background: #eff6ff; color: #1d4ed8; }
.chip.man { background: #f0fdf4; color: #15803d; }
.chip.sys { background: #f3f4f6; color: #6b7280; }

.actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
.picker { margin-top: 12px; border-top: 1px solid var(--border-2); padding-top: 10px; }
.pgrp { margin-bottom: 8px; }
.pgname { font-size: 11px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
.ptags { display: flex; flex-wrap: wrap; gap: 5px; }
.ptag { font-size: 12px; padding: 4px 10px; }
.ptag.used { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-border); }
</style>
