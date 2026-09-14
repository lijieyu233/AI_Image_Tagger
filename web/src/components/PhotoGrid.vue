<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';

const props = defineProps({ photos: Array, selectedIds: { type: Object, default: () => new Set() } });
const emit = defineEmits(['open', 'select', 'load-more', 'reject']);

const sentinel = ref(null);
let observer = null;
onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) emit('load-more');
  }, { rootMargin: '600px' });
  if (sentinel.value) observer.observe(sentinel.value);
});
onBeforeUnmount(() => observer && observer.disconnect());

function onCellClick(p, e) {
  if (e.ctrlKey || e.metaKey) emit('select', p.id);
  else emit('open', p.id);
}

function tagClass(t) {
  if (t.source === 'manual') return 'man';
  if (t.source === 'clip') return 'auto';
  if (t.source === 'vlm') return 'vlm';
  return 'sys';
}
// 来源角标：有云端 VLM 标签 → 🧠，否则本地模型 ⚡
function sourceBadge(p) {
  return (p.tags || []).some((t) => t.source === 'vlm') ? '🧠' : '⚡';
}
// 待用户把关（有低置信自动标签）
function needsReview(p) {
  return (p.tags || []).some((t) => !t.rejected && (t.source === 'clip' || t.source === 'vlm') && t.confidence != null && t.confidence < 0.24);
}

// 快捷纠错 popover：勾选要移除的自动标签
const fbOpenId = ref(null);
const fbMarks = ref({});
function toggleFb(p) {
  fbOpenId.value = fbOpenId.value === p.id ? null : p.id;
  fbMarks.value = {};
}
function autoTags(p) {
  return (p.tags || []).filter((t) => !t.rejected && (t.source === 'clip' || t.source === 'vlm'));
}
function submitReject(p) {
  const names = Object.entries(fbMarks.value).filter(([, v]) => v).map(([k]) => k);
  if (!names.length) { fbOpenId.value = null; return; }
  emit('reject', p.id, names);
  fbOpenId.value = null;
}
function onDocClick(e) {
  if (!e.target.closest?.('.fb') && !e.target.closest?.('.fbpop')) fbOpenId.value = null;
}
onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div class="grid-wrap">
    <div class="grid">
      <div v-for="p in photos" :key="p.id" class="cell" :class="{ sel: selectedIds.has(p.id) }" @click="onCellClick(p, $event)">
        <div class="img">
          <img :src="api.thumb(p.id)" loading="lazy" />
          <span class="date">{{ (p.taken_at || '').slice(0, 10).slice(5) }}</span>
          <span class="src" :title="sourceBadge(p) === '🧠' ? '含 AI 增强标签（云端）' : '本地模型打标，图片未离开电脑'">{{ sourceBadge(p) }}</span>
          <span v-if="!p.tags || !p.tags.length" class="pending">待分类</span>
          <span v-else-if="needsReview(p)" class="review" title="有没把握的标签，点开可把关">?</span>
          <span v-if="selectedIds.has(p.id)" class="pick">✓</span>

          <!-- hover 快捷纠错 -->
          <div class="fb" @click.stop>
            <button class="fbb" title="有标签分错了？点这里移除" @click.stop="toggleFb(p)">👎</button>
          </div>
          <div v-if="fbOpenId === p.id" class="fbpop" @click.stop>
            <div class="fbt">哪些标签错了？</div>
            <label v-for="t in autoTags(p)" :key="t.name" class="fbi">
              <input type="checkbox" v-model="fbMarks[t.name]" /> {{ t.name }}
            </label>
            <div v-if="!autoTags(p).length" class="fbnone">这张没有自动标签</div>
            <button class="primary fbs" :disabled="!Object.values(fbMarks).some(Boolean)" @click="submitReject(p)">移除所选</button>
          </div>
        </div>
        <div class="tags">
          <span v-for="t in (p.tags || []).slice(0, 3)" :key="t.name" class="chip" :class="tagClass(t)">{{ t.name }}</span>
          <span v-if="(p.tags || []).length > 3" class="more">+{{ p.tags.length - 3 }}</span>
        </div>
      </div>
    </div>
    <div ref="sentinel" class="sentinel" />
  </div>
</template>

<style scoped>
.grid-wrap { flex: 1; overflow-y: auto; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; padding: 16px; align-content: start; }
.cell {
  background: var(--surface); border-radius: var(--radius); overflow: hidden; cursor: pointer;
  box-shadow: var(--shadow-sm); border: 1px solid transparent; transition: all .15s;
}
.cell:hover { box-shadow: var(--shadow-md); border-color: var(--accent-border); transform: translateY(-1px); }
.cell.sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.pick { position: absolute; left: 6px; top: 6px; width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 11px; display: flex; align-items: center; justify-content: center; }
.img { aspect-ratio: 1; background: var(--surface-2); position: relative; overflow: hidden; }
.img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.date { position: absolute; top: 6px; right: 6px; font-size: 10px; color: #fff; background: rgba(0, 0, 0, .55); padding: 2px 6px; border-radius: 5px; }
.src { position: absolute; bottom: 6px; right: 6px; font-size: 10px; background: rgba(0, 0, 0, .55); padding: 2px 5px; border-radius: 5px; }
.pending { position: absolute; left: 6px; top: 6px; font-size: 10px; color: #cbd5e1; background: rgba(0, 0, 0, .55); padding: 2px 6px; border-radius: 5px; }
.review { position: absolute; left: 6px; top: 6px; font-size: 10px; color: #1c1917; background: var(--warn); padding: 2px 6px; border-radius: 5px; font-weight: 700; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; padding: 7px 8px; min-height: 26px; }
.chip { font-size: 10px; padding: 2px 7px; border-radius: 5px; font-weight: 500; }
.more { font-size: 10px; color: var(--muted-2); align-self: center; }
.sentinel { height: 1px; }

.fb { position: absolute; left: 6px; bottom: 6px; opacity: 0; transition: opacity .15s; }
.cell:hover .fb { opacity: 1; }
.fbb { font-size: 11px; padding: 2px 7px; background: rgba(0, 0, 0, .55); border: none; color: #fff; border-radius: 5px; }
.fbpop { position: absolute; left: 6px; bottom: 30px; z-index: 30; width: 160px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-lg); padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.fbt { font-size: 12px; font-weight: 600; color: var(--text); }
.fbi { font-size: 12px; display: flex; gap: 6px; align-items: center; cursor: pointer; color: var(--text-2); }
.fbnone { font-size: 11px; color: var(--muted-2); }
.fbs { font-size: 12px; padding: 5px 8px; }
</style>
