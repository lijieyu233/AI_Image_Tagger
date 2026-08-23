<script setup>
import { computed } from 'vue';

const props = defineProps({
  vocab: Array, sourceTags: Array, countMap: Object, stats: Object,
  selectedTags: Array, smart: String, view: String,
  tagging: Boolean, modelReady: Boolean,
});
const emit = defineEmits(['toggle', 'smart', 'home', 'import', 'classify']);

const smartAlbums = computed(() => [
  { key: 'inbox', label: '收件箱', count: props.stats.inbox ?? 0 },
  { key: 'unclassified', label: '未分类', count: props.stats.unclassified ?? 0 },
  { key: 'review', label: '待确认', count: props.stats.review ?? 0 },
  { key: 'dup', label: '重复', count: props.stats.dup ?? 0 },
  { key: 'doc', label: '可能证件', count: props.stats.doc ?? 0 },
]);

// 高频标签：计数最多的前 6 个
const hotTags = computed(() => {
  const entries = Object.entries(props.countMap || {})
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, c]) => ({ name, count: c }));
  return entries;
});
</script>

<template>
  <aside class="side">
    <div class="brand"><span class="logo">图</span>本地图库</div>

    <button class="primary" @click="emit('import')">📂 导入文件夹</button>
    <button :disabled="tagging" @click="emit('classify')">{{ tagging ? '⏳ 分类中' : '✨ 启动分类' }}</button>

    <div class="model" :class="{ ready: modelReady }">
      <span class="md" /> {{ modelReady ? '模型已就绪' : '模型未下载' }}
    </div>

    <div class="h">智能相册</div>
    <div class="t" :class="{ on: view === 'home' && !smart }" @click="emit('home')">全部 <span>{{ stats.total }}</span></div>
    <div v-for="a in smartAlbums" :key="a.key" class="t" :class="{ on: smart === a.key }" @click="emit('smart', a.key)">
      {{ a.label }} <span>{{ a.count }}</span>
    </div>

    <div v-if="hotTags.length" class="h">高频标签</div>
    <div v-for="t in hotTags" :key="t.name" class="t" :class="{ on: selectedTags.includes(t.name) }" @click="emit('toggle', t.name)">
      {{ t.name }} <span>{{ t.count }}</span>
    </div>
  </aside>
</template>

<style scoped>
.side { width: 216px; min-width: 216px; background: var(--surface); border-right: 1px solid var(--border); padding: 14px 10px; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.brand { font-weight: 700; font-size: 15px; margin: 0 8px 10px; display: flex; align-items: center; gap: 7px; }
.logo { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, #3b82f6, #2563eb); display: flex; align-items: center; justify-content: center; color: #fff; font-size: 12px; }
.side button { width: 100%; }
.model { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); padding: 3px 8px; border-radius: 6px; background: var(--surface-2); }
.model .md { width: 7px; height: 7px; border-radius: 50%; background: var(--muted-2); }
.model.ready { color: var(--ok); }
.model.ready .md { background: var(--ok); }
.h { color: var(--muted-2); font-size: 11px; font-weight: 600; letter-spacing: .05em; margin: 14px 10px 5px; }
.t { display: flex; justify-content: space-between; align-items: center; padding: 7px 10px; border-radius: 8px; margin-bottom: 1px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.t:hover { background: var(--surface-2); }
.t.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.t span { color: var(--muted); font-size: 11px; font-weight: 400; }
.t.on span { color: var(--accent); }
</style>
