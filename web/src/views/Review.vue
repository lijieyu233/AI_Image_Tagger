<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';
import { useLibrary } from '../composables/useLibrary.js';

const { reviewItems, reviewIdx, reviewLoading, reviewSubmit, reviewSkip, goHome, notify } = useLibrary();

// 每个标签的判定三态循环：未判 → ✓认可 → ✗驳回 → 未判。切图时重置。
const verdicts = ref({});
const current = computed(() => reviewItems.value[reviewIdx.value] || null);
const clipTags = computed(() => (current.value?.tags || []).filter((t) => !t.rejected && (t.source === 'clip' || t.source === 'vlm')));

watch(() => current.value?.id, () => { verdicts.value = {}; });

function cycleVerdict(name) {
  const cur = verdicts.value[name];
  const next = cur == null ? true : (cur === true ? false : null);
  verdicts.value = { ...verdicts.value, [name]: next };
}

// 原图浏览器解不了（如 HEIC）时退回缩略图
function onImgErr(e, id) {
  const el = e.target;
  if (!el.dataset.fb) { el.dataset.fb = '1'; el.src = api.thumb(id); }
}

const kept = computed(() => clipTags.value.filter((t) => verdicts.value[t.name] !== false).map((t) => t.name));
const removed = computed(() => clipTags.value.filter((t) => verdicts.value[t.name] === false).map((t) => t.name));

async function approveAll() {
  if (!clipTags.value.length) return next();
  await reviewSubmit(clipTags.value.map((t) => t.name), []);
}
async function rejectAll() {
  await reviewSubmit([], clipTags.value.map((t) => t.name));
}
async function submitMarks() {
  if (!removed.value.length) { notify('先点标签把它标成 ✗，再确认'); return; }
  await reviewSubmit(kept.value, removed.value);
}
async function next() { reviewSkip(); }

function onKey(e) {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') next();
  else if (e.key === '1') approveAll();
  else if (e.key === '2') rejectAll();
  else if (e.key === 'Enter') submitMarks();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const done = computed(() => !reviewLoading.value && reviewItems.value.length === 0);
</script>

<template>
  <div class="rv">
    <div class="rv-head">
      <span class="rv-title">帮你把关：模型没把握的照片</span>
      <span class="rv-count">剩 <b>{{ reviewItems.length }}</b> 张 · 快捷键 1=全对 2=全不对 →=下一张 Enter=确认</span>
      <button @click="goHome">完成，返回图库</button>
    </div>

    <div v-if="reviewLoading" class="loading">⏳ 加载中…</div>

    <div v-else-if="done" class="rv-done">
      <div class="big">🎉</div>
      <div class="t">全部处理完！</div>
      <p class="muted">你纠正的每个标签都被记下来了，以后同类照片会更准。</p>
      <button class="primary" @click="goHome">返回图库</button>
    </div>

    <div v-else-if="current" class="rv-body">
      <div class="pic">
        <img :src="api.file(current.id)" @error="onImgErr($event, current.id)" />
        <div class="path">{{ current.path }}</div>
      </div>
      <div class="side">
        <div class="h">模型的建议（点标签切换：✓ 认可 → ✗ 驳回 → 取消）</div>
        <div class="taglist">
          <button v-for="t in clipTags" :key="t.name" class="vtag"
            :class="{ keep: verdicts[t.name] === true, drop: verdicts[t.name] === false }"
            @click="cycleVerdict(t.name)">
            <span class="mark">{{ verdicts[t.name] === false ? '✗' : '✓' }}</span>
            {{ t.name }}
            <span v-if="t.confidence != null" class="sc">{{ Number(t.confidence).toFixed(2) }}</span>
          </button>
          <div v-if="!clipTags.length" class="none">这张没有待确认的标签，可直接跳过</div>
        </div>

        <div class="acts">
          <button class="big-btn ok" @click="approveAll">✓ 都对（1）</button>
          <button class="big-btn bad" @click="rejectAll">✗ 都不对（2）</button>
        </div>
        <button class="wide primary" :disabled="!removed.length" @click="submitMarks">
          确认：保留 {{ kept.length }} 个 · 移除 {{ removed.length }} 个（Enter）
        </button>
        <button class="wide" @click="next">跳过这张（→）</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rv { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.rv-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
.rv-title { font-weight: 700; font-size: 14px; }
.rv-count { color: var(--muted); font-size: 12px; margin-right: auto; }
.rv-count b { color: var(--warn); }
.loading { text-align: center; color: var(--muted); padding: 30px; }

.rv-done { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.rv-done .big { font-size: 44px; }
.rv-done .t { font-size: 17px; font-weight: 700; }
.muted { color: var(--muted); font-size: 13px; }

.rv-body { flex: 1; display: flex; min-height: 0; }
.pic { flex: 1; background: #07090d; display: flex; align-items: center; justify-content: center; position: relative; min-width: 0; }
.pic img { max-width: 94%; max-height: 94%; object-fit: contain; border-radius: 6px; }
.path { position: absolute; bottom: 10px; left: 12px; right: 12px; color: rgba(232, 236, 243, .4); font-size: 11px; font-family: ui-monospace, monospace; word-break: break-all; }

.side { width: 340px; min-width: 340px; background: var(--surface); border-left: 1px solid var(--border); padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.h { color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .05em; }
.taglist { display: flex; flex-wrap: wrap; gap: 6px; }
.vtag { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 6px 12px; font-size: 13px; border: 1.5px solid var(--border); background: var(--surface-2); color: var(--text-2); }
.vtag .mark { width: 16px; height: 16px; border-radius: 50%; background: var(--border); color: var(--muted-2); font-size: 10px; display: inline-flex; align-items: center; justify-content: center; }
.vtag .sc { opacity: .55; font-size: 11px; font-family: ui-monospace, monospace; }
.vtag.keep { border-color: var(--ok); background: var(--ok-soft); color: var(--ok); }
.vtag.keep .mark { background: var(--ok); color: #052e13; }
.vtag.drop { border-color: var(--danger); background: var(--danger-soft); color: var(--danger); text-decoration: line-through; }
.vtag.drop .mark { background: var(--danger); color: #2b0505; }
.none { color: var(--muted-2); font-size: 12px; }

.acts { display: flex; gap: 8px; margin-top: 4px; }
.big-btn { flex: 1; padding: 12px 8px; font-size: 14px; font-weight: 700; border-radius: 12px; }
.big-btn.ok { background: var(--ok-soft); color: var(--ok); border-color: rgba(74, 222, 128, .35); }
.big-btn.ok:hover { border-color: var(--ok); color: var(--ok); }
.big-btn.bad { background: var(--danger-soft); color: var(--danger); border-color: rgba(248, 113, 113, .35); }
.big-btn.bad:hover { border-color: var(--danger); color: var(--danger); }
.wide { width: 100%; }
</style>
