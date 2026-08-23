<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from './api.js';
import TagPanel from './components/TagPanel.vue';
import PhotoGrid from './components/PhotoGrid.vue';
import Lightbox from './components/Lightbox.vue';

const info = ref({ inboxDir: '', modelReady: false });
const vocab = ref([]);
const sourceTags = ref([]);
const countMap = ref({});
const stats = ref({ total: 0, pending: 0, inbox: 0, unclassified: 0, dup: 0, review: 0, doc: 0 });

const view = ref('home');          // 'home' | 'light'
const selectedTags = ref([]);      // 筛选标签名
const tagFilter = ref('');
const searchOpen = ref(false);
const op = ref('and');
const smart = ref(null);
const dateFrom = ref('');
const dateTo = ref('');

const photos = ref([]);
const total = ref(0);
const loading = ref(false);
const offset = ref(0);
const limit = 200;

const selected = ref(null);
const selectedIndex = ref(-1);

const showImport = ref(false);
const importDir = ref('');
const importing = ref(false);
const importResult = ref(null);
const browsing = ref(false);

const tagging = ref(false);
const tagResult = ref(null);

const toast = ref(null);
let toastTimer = null;
function notify(msg) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), 3000);
}

// 分组后的标签（popover 用）
const tagGroups = computed(() => {
  const groups = [];
  for (const g of vocab.value) {
    const items = g.tags
      .filter((n) => !tagFilter.value || n.includes(tagFilter.value))
      .map((n) => ({ name: n, group: g.name, kind: g.kind, count: countMap.value[n] ?? 0 }));
    if (items.length) groups.push({ name: g.name, items });
  }
  if (sourceTags.value.length) {
    const items = sourceTags.value
      .filter((t) => !tagFilter.value || t.name.includes(tagFilter.value))
      .map((t) => ({ name: t.name, group: '来源目录', kind: 'sys', count: t.c }));
    if (items.length) groups.push({ name: '来源目录', items });
  }
  return groups;
});

const activeFilters = computed(() => ({
  tags: selectedTags.value.join(','),
  op: op.value,
  smart: smart.value,
  from: dateFrom.value || undefined,
  to: dateTo.value || undefined,
}));

async function loadInfo() { try { info.value = await api.info(); } catch {} }
async function loadVocab() {
  const r = await api.tags();
  vocab.value = r.vocab; sourceTags.value = r.sourceTags; countMap.value = r.countMap;
}
async function loadStats() { stats.value = await api.stats(); }

async function loadPhotos(reset = true) {
  if (loading.value) return;
  loading.value = true;
  try {
    if (reset) { offset.value = 0; photos.value = []; }
    const r = await api.photos({ ...activeFilters.value, limit, offset: offset.value });
    if (reset) photos.value = r.items;
    else photos.value = photos.value.concat(r.items);
    total.value = r.total;
    offset.value += r.items.length;
  } finally { loading.value = false; }
}

// 筛选：点击标签
function toggleFilter(name) {
  const i = selectedTags.value.indexOf(name);
  if (i >= 0) selectedTags.value.splice(i, 1);
  else selectedTags.value.push(name);
  loadPhotos(true);
}
function removeFilter(name) { selectedTags.value = selectedTags.value.filter((x) => x !== name); loadPhotos(true); }
function clearFilters() {
  selectedTags.value = []; smart.value = null; dateFrom.value = ''; dateTo.value = '';
  loadPhotos(true);
}
function selectSmart(name) {
  smart.value = smart.value === name ? null : name;
  if (smart.value) selectedTags.value = [];
  loadPhotos(true);
}
function setOp(v) { op.value = v; loadPhotos(true); }

// 灯箱（主区域视图切换）
async function openPhoto(id) {
  selected.value = await api.photo(id);
  selectedIndex.value = photos.value.findIndex((p) => p.id === id);
  view.value = 'light';
}
function closePhoto() { view.value = 'home'; selected.value = null; selectedIndex.value = -1; }
function step(dir) {
  if (selectedIndex.value < 0) return;
  const n = selectedIndex.value + dir;
  if (n >= 0 && n < photos.value.length) openPhoto(photos.value[n].id);
}

async function applyTagChange(add, remove) {
  if (!selected.value) return;
  await api.setTags(selected.value.id, add, remove);
  selected.value = await api.photo(selected.value.id);
  const item = photos.value.find((p) => p.id === selected.value.id);
  if (item) item.tags = selected.value.tags;
  loadVocab(); loadStats();
}

// 导入
async function doImport() {
  if (importing.value) return;
  importing.value = true; importResult.value = null;
  try {
    const dir = importDir.value.trim() || info.value.inboxDir;
    const r = await api.import(dir);
    importResult.value = r;
    notify(`导入完成：新增 ${r.stats.new}，重复 ${r.stats.dup}`);
    await Promise.all([loadPhotos(true), loadStats(), loadVocab(), loadInfo()]);
  } catch (e) { notify('导入失败：' + e.message); }
  finally { importing.value = false; }
}
async function doBrowse() {
  if (browsing.value) return;
  browsing.value = true;
  try { const r = await api.browse(); if (r?.dir) importDir.value = r.dir; }
  catch (e) { notify('无法打开选择器：' + e.message); }
  finally { browsing.value = false; }
}

// 分类
async function doTag() {
  if (tagging.value) return;
  tagging.value = true; tagResult.value = null;
  try {
    const r = await api.tag(200);
    tagResult.value = r;
    notify(`打标完成：处理 ${r.processed}，命中 ${r.tagged}`);
    await Promise.all([loadPhotos(true), loadStats(), loadVocab()]);
  } catch (e) { notify('打标失败：' + e.message + '（首次需下载模型）'); }
  finally { tagging.value = false; }
}

onMounted(() => { loadInfo(); loadVocab(); loadStats(); loadPhotos(true); });
</script>

<template>
  <!-- 标题栏 -->
  <div class="titlebar">
    <span class="dot" style="background:#f87171" /><span class="dot" style="background:#fbbf24" /><span class="dot" style="background:#34d399" />
    <span class="tb-title">本地图库</span>
    <span class="tb-right">{{ stats.total }} 张{{ stats.unclassified ? ` · 未分类 ${stats.unclassified}` : '' }}</span>
  </div>

  <div class="appshell">
    <!-- 侧栏 -->
    <TagPanel
      :vocab="vocab" :source-tags="sourceTags" :count-map="countMap" :stats="stats"
      :selected-tags="selectedTags" :smart="smart" :view="view"
      @toggle="toggleFilter" @smart="selectSmart" @home="() => { smart = null; selectedTags = []; dateFrom=''; dateTo=''; loadPhotos(true); }"
      @set-op="setOp"
      @import="showImport = true" @classify="doTag"
      :tagging="tagging" :model-ready="info.modelReady"
    />

    <!-- 主区域 -->
    <section class="main">
      <!-- 灯箱视图 -->
      <Lightbox
        v-if="view === 'light' && selected"
        :photo="selected" :vocab="vocab" :source-tags="sourceTags"
        :has-prev="selectedIndex > 0" :has-next="selectedIndex >= 0 && selectedIndex < photos.length - 1"
        @close="closePhoto" @prev="step(-1)" @next="step(1)" @change="applyTagChange"
      />

      <!-- 网格视图 -->
      <template v-else>
        <!-- 工具栏 -->
        <div class="toolbar">
          <div class="searchwrap">
            <div class="search" :class="{ open: searchOpen }" @click="searchOpen = !searchOpen">
              <template v-if="!selectedTags.length"><span class="ph">🔍 点击选择标签筛选…</span></template>
              <span v-for="t in selectedTags" :key="t" class="schip" @click.stop>{{ t }} <i @click.stop="removeFilter(t)">×</i></span>
            </div>
            <!-- 搜索 popover -->
            <div v-if="searchOpen" class="popover" @click.stop>
              <div class="phead"><input v-model="tagFilter" placeholder="输入过滤标签…" /></div>
              <div class="pbody">
                <div v-for="g in tagGroups" :key="g.name" class="pgroup">
                  <div class="pgname">{{ g.name }}</div>
                  <div v-for="t in g.items" :key="t.name" class="pitem" :class="{ on: selectedTags.includes(t.name) }" @click="toggleFilter(t.name)">
                    <span>{{ t.name }}<span v-if="g.name === '文档'" class="lock"> 🔒</span></span>
                    <span class="right"><span class="n">{{ t.count }}</span><span class="ck">{{ selectedTags.includes(t.name) ? '✓' : '' }}</span></span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <button class="primary" @click="showImport = true">📂 导入文件夹</button>
          <button class="primary" @click="doTag" :disabled="tagging">{{ tagging ? '⏳ 分类中' : '✨ 启动分类' }}</button>
          <button @click="doTag" :disabled="tagging">⤓ 导出</button>
        </div>

        <!-- 筛选 chips 行 -->
        <div v-if="selectedTags.length || smart" class="filterrow">
          <span class="label">筛选：</span>
          <span v-for="t in selectedTags" :key="t" class="chip auto">{{ t }} <i class="x" @click="removeFilter(t)">×</i></span>
          <span v-if="smart" class="chip auto">{{ smart }} <i class="x" @click="selectSmart(smart)">×</i></span>
          <div class="opseg">
            <button :class="{ on: op === 'and' }" @click="setOp('and')">AND 且</button>
            <button :class="{ on: op === 'or' }" @click="setOp('or')">OR 或</button>
          </div>
          <button class="clear" @click="clearFilters">清除</button>
        </div>

        <!-- 空状态 -->
        <div v-if="total === 0 && !loading" class="empty">
          <div class="big">📷</div>
          <div class="t">还没有图片</div>
          <p class="muted">点「导入文件夹」选目录，图进来后再点「启动分类」。</p>
          <button class="primary" @click="showImport = true">📂 导入文件夹</button>
        </div>

        <!-- 网格 -->
        <PhotoGrid v-else :photos="photos" @open="openPhoto" @load-more="loadPhotos(false)" />
      </template>
    </section>
  </div>

  <!-- 导入弹窗 -->
  <div v-if="showImport" class="mask" @click.self="showImport = false">
    <div class="dialog">
      <div class="dlg-head">导入文件夹</div>
      <div class="dlg-body">
        <p class="muted">点「浏览」弹出系统文件夹选择器：</p>
        <div class="dir-row">
          <input v-model="importDir" :placeholder="info.inboxDir || 'data/inbox'" />
          <button class="primary" :disabled="browsing" @click="doBrowse">{{ browsing ? '打开中…' : '📂 浏览' }}</button>
        </div>
        <p class="muted small">支持 jpg/png/webp/gif/heic · 按内容去重</p>
        <div v-if="importing" class="busy">⏳ 正在扫描并入库…</div>
        <div v-if="importResult && !importing" class="result">扫描 {{ importResult.stats.total }} · 新增 <b class="ok">{{ importResult.stats.new }}</b> · 重复 {{ importResult.stats.dup }}</div>
      </div>
      <div class="dlg-foot">
        <button @click="showImport = false">取消</button>
        <button class="primary" :disabled="importing" @click="doImport">{{ importing ? '导入中…' : '开始导入' }}</button>
      </div>
    </div>
  </div>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>

<style scoped>
.titlebar { height: 38px; background: #fff; display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.dot { width: 10px; height: 10px; border-radius: 50%; }
.tb-title { font-size: 13px; font-weight: 600; color: var(--text-2); margin-left: 4px; }
.tb-right { margin-left: auto; color: var(--muted); font-size: 12px; }

.appshell { display: flex; flex: 1; overflow: hidden; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); }

.toolbar { display: flex; gap: 8px; align-items: center; padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
.searchwrap { position: relative; flex: 1; min-width: 200px; }
.search { width: 100%; min-height: 38px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; cursor: pointer; font-size: 13px; }
.search.open { border-color: var(--accent); }
.search .ph { color: var(--muted-2); }
.schip { background: var(--accent-soft); color: var(--accent); border-radius: 6px; padding: 2px 8px; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; }
.schip i { cursor: pointer; font-style: normal; opacity: .7; }
.popover { position: absolute; top: calc(100% + 6px); left: 0; width: 440px; max-height: 420px; background: #fff; border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); z-index: 50; display: flex; flex-direction: column; overflow: hidden; }
.phead { padding: 10px 12px; border-bottom: 1px solid var(--border-2); }
.phead input { width: 100%; }
.pbody { overflow: auto; padding: 8px; }
.pgroup { margin-bottom: 4px; }
.pgname { font-size: 11px; font-weight: 600; color: var(--muted); padding: 6px 8px 3px; }
.pitem { display: flex; justify-content: space-between; align-items: center; padding: 7px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.pitem:hover { background: var(--surface-2); }
.pitem.on { background: var(--accent-soft); color: var(--accent); }
.pitem .right { display: flex; align-items: center; gap: 6px; }
.pitem .n { color: var(--muted); font-size: 11px; }
.pitem .lock { color: var(--muted-2); font-size: 11px; }
.ck { width: 16px; height: 16px; border: 1.5px solid var(--border); border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; color: #fff; }
.pitem.on .ck { background: var(--accent); border-color: var(--accent); }

.filterrow { display: flex; gap: 6px; align-items: center; padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--border-2); flex-wrap: wrap; }
.filterrow .label { color: var(--muted); font-size: 12px; }
.filterrow .chip i { font-style: normal; }
.opseg { display: flex; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-left: auto; }
.opseg button { border: none; background: none; padding: 5px 12px; font-size: 12px; color: var(--muted); }
.opseg button.on { background: var(--accent); color: #fff; }
.clear { color: var(--muted); font-size: 12px; border: none; background: none; padding: 4px 6px; }
.clear:hover { color: var(--danger); }

.empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--muted); padding: 20px; }
.empty .big { font-size: 44px; }
.empty .t { font-size: 17px; font-weight: 700; color: var(--text); }

.mask { position: fixed; inset: 0; background: rgba(17,24,39,.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
.dialog { width: 440px; background: #fff; border-radius: 14px; overflow: hidden; box-shadow: var(--shadow-lg); }
.dlg-head { padding: 14px 16px; font-weight: 600; font-size: 14px; border-bottom: 1px solid var(--border-2); }
.dlg-body { padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.dir-row { display: flex; gap: 8px; }
.dir-row input { flex: 1; }
.busy { padding: 10px; text-align: center; color: var(--accent); }
.result { background: var(--surface-2); border-radius: 8px; padding: 10px; font-size: 13px; }
.result .ok { color: var(--ok); }
.dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; background: var(--surface-2); border-top: 1px solid var(--border-2); }
.dlg-foot button { width: auto; }
.muted { color: var(--muted); }
.small { font-size: 11px; }

.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #111827; color: #fff; padding: 9px 16px; border-radius: 10px; font-size: 13px; z-index: 200; box-shadow: var(--shadow-lg); }
</style>
