<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';

const props = defineProps({ photos: Array });
const emit = defineEmits(['open', 'load-more']);

const sentinel = ref(null);
let observer = null;
onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) emit('load-more');
  }, { rootMargin: '600px' });
  if (sentinel.value) observer.observe(sentinel.value);
});
onBeforeUnmount(() => observer && observer.disconnect());

function tagClass(t) {
  if (t.source === 'manual') return 'man';
  if (t.source === 'clip') return 'auto';
  return 'sys';
}
</script>

<template>
  <div class="grid-wrap">
    <div class="grid">
      <div v-for="p in photos" :key="p.id" class="cell" @click="emit('open', p.id)">
        <div class="img">
          <img :src="api.thumb(p.id)" loading="lazy" />
          <span class="date">{{ (p.taken_at || '').slice(0, 10).slice(5) }}</span>
          <span v-if="!p.tags || !p.tags.length" class="pending">待分类</span>
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
.img { aspect-ratio: 1; background: #e5e7eb; position: relative; overflow: hidden; }
.img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.date { position: absolute; top: 6px; right: 6px; font-size: 10px; color: #fff; background: rgba(0,0,0,.45); padding: 2px 6px; border-radius: 5px; }
.pending { position: absolute; left: 6px; top: 6px; font-size: 10px; color: #fff; background: rgba(0,0,0,.45); padding: 2px 6px; border-radius: 5px; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; padding: 7px 8px; min-height: 26px; }
.chip { font-size: 10px; padding: 2px 7px; border-radius: 5px; font-weight: 500; }
.more { font-size: 10px; color: var(--muted-2); align-self: center; }
.sentinel { height: 1px; }
</style>
