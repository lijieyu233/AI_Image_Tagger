<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';
import { useLibrary } from '../composables/useLibrary.js';
import PhotoGrid from '../components/PhotoGrid.vue';

const {
  stats, vocab, view, selectedTags, tagFilter, searchQuery, searchOpen,
  op, smart, dateFrom, dateTo, datePreset,
  photos, total, loading, selectedIds, tagging, importing,
  tagGroups, suggestionTags,
  runSearch, toggleFilter, removeFilter, clearFilters, goHome,
  onDateChange, setDatePreset, selectSmart, setOp,
  openPhoto, toggleSelect, doImportFolder, doImportFiles, openWizard,
  askConfirm, clearSelect, loadPhotos, loadStats, loadVocab, notify,
  rejectPhotoTags, doExport,
  batchReclassify, batchAiClassify, batchClassifying, aiSettings,
} = useLibrary();

const fileInput = ref(null);
const moreOpen = ref(false);
const dateMenuOpen = ref(false);
const popFilter = ref(null);
const tagTotal = computed(() => tagGroups.value.reduce((n, g) => n + g.items.length, 0));
function moreAction2(fn) { moreOpen.value = false; fn(); }

// 智能筛选框：聚焦展开标签面板；输入即过滤；回车=按关键字搜索
watch(searchOpen, (open) => {
  if (open) { tagFilter.value = ''; nextTick(() => popFilter.value?.focus()); }
});

// 日期标签（下拉按钮上显示当前状态）
const dateLabel = computed(() => {
  if (datePreset.value === 'month') return '本月';
  if (datePreset.value === 'year') return '今年';
  if (dateFrom.value || dateTo.value) {
    const f = dateFrom.value || '…';
    const t = dateTo.value || '…';
    return `${f.slice(5)} ~ ${t.slice(5)}`;
  }
  return '时间不限';
});
function pickDate(kind) {
  dateMenuOpen.value = false;
  setDatePreset(kind);
}

// 弹层统一「点到外面 / Esc 就关」
function onDocClick(e) {
  if (!e.target.closest?.('.importwrap')) moreOpen.value = false;
  if (!e.target.closest?.('.datemenu')) dateMenuOpen.value = false;
  if (!e.target.closest?.('.searchwrap')) searchOpen.value = false;
}
function onKey(e) {
  if (e.key === 'Escape') { moreOpen.value = false; dateMenuOpen.value = false; searchOpen.value = false; }
}
onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
});

// 批量操作
const batchTagOpen = ref(false);
const batchTagName = ref('');
function batchAdd() { if (!selectedIds.value.size) return; batchTagOpen.value = true; batchTagName.value = ''; }
async function batchAddConfirm() {
  const names = batchTagName.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) { batchTagOpen.value = false; return; }
  const ids = [...selectedIds.value];
  for (const id of ids) { try { await api.setTags(id, names, []); } catch {} }
  batchTagOpen.value = false;
  notify(`已为 ${ids.length} 张添加标签`);
  await Promise.all([loadPhotos(true), loadStats(), loadVocab()]);
}
async function batchExport() {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  const picked = await api.browse();
  const target = picked?.dir;
  if (!target) { notify('未选择导出目录'); return; }
  try {
    const r = await api.export({ ids }, target);
    notify(`已导出 ${r.copied}/${r.total} 张`);
  } catch (e) { notify('批量导出失败：' + e.message); }
}
function batchDelete() {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  askConfirm(`确定从图库删除选中的 ${ids.length} 张的索引与缩略图吗？原图不会被删除。`, async () => {
    for (const id of ids) { try { await api.deletePhoto(id); } catch {} }
    photos.value = photos.value.filter((p) => !selectedIds.value.has(p.id));
    clearSelect();
    notify('已移除选中项');
    await Promise.all([loadStats(), loadVocab()]);
  });
}
</script>

<template>
  <!-- 搜索视图 -->
  <template v-if="view === 'search'">
    <div class="search-head">
      <span class="sh-title">搜索「{{ searchQuery }}」</span>
      <input class="sh-input" v-model="searchQuery" @keyup.enter="runSearch" placeholder="搜索标签，如 旅行" />
      <button class="primary" @click="runSearch">搜索</button>
      <button @click="goHome">返回</button>
      <span class="sh-count">共 {{ total }} 张</span>
    </div>
    <div class="search-body">
      <aside class="sug">
        <div class="h">建议词（点选搜索）</div>
        <div v-for="[name, c] in suggestionTags" :key="name" class="st" :class="{ on: searchQuery.trim() === name }" @click="searchQuery = name; runSearch()">
          <span>{{ name }}</span><span class="n">{{ c }}</span>
        </div>
        <div v-if="!suggestionTags.length" class="none">无匹配标签</div>
      </aside>
      <div class="results">
        <PhotoGrid v-if="total" :photos="photos" :selected-ids="selectedIds" @open="openPhoto" @select="toggleSelect" @load-more="loadPhotos(false)" @reject="rejectPhotoTags" />
        <div v-else class="empty"><div class="big">🔍</div><div class="t">没有匹配「{{ searchQuery }}」的图片</div></div>
      </div>
    </div>
  </template>

  <!-- 网格视图（home） -->
  <template v-else>
    <!-- 空库三步引导 -->
    <div v-if="stats.total === 0 && !loading" class="onboard">
      <div class="ob-title">三步把一堆图变成能搜的图库</div>
      <div class="ob-steps">
        <div class="ob-step"><div class="n">1</div><div class="ic">📂</div><b>导入</b><span>选一个装图片的文件夹，原图留在原地不动</span></div>
        <div class="ob-arrow">→</div>
        <div class="ob-step"><div class="n">2</div><div class="ic">⚡</div><b>自动分类</b><span>本地 AI 对照标签词表打标，图片不离开电脑</span></div>
        <div class="ob-arrow">→</div>
        <div class="ob-step"><div class="n">3</div><div class="ic">✅</div><b>你来拍板</b><span>没把握的进「待确认」，点一下对错就越来越准</span></div>
      </div>
      <button class="primary ob-cta" @click="doImportFolder">📂 选择文件夹，开始导入</button>
    </div>

    <template v-else>
      <!-- ===== 单一工具栏：筛选框（搜字/选标签二合一） + 时间 + 导入 + 开始分类 ===== -->
      <div class="toolbar">
        <div class="searchwrap">
          <div class="smartbox" :class="{ open: searchOpen }" @click.stop="searchOpen = true">
            <span class="sicon">🔍</span>
            <span v-for="t in selectedTags" :key="t" class="schip" @click.stop="removeFilter(t)">{{ t }} <i>×</i></span>
            <input ref="smartInput" v-model="searchQuery" :placeholder="selectedTags.length ? '再加条件，或回车搜索…' : '搜索标签：输入关键字或从下拉里选'"
              @focus="searchOpen = true" @keyup.enter="runSearch" @keyup.esc="searchOpen = false" />
            <button v-if="searchQuery || selectedTags.length" class="clr" title="清空" @click.stop="searchQuery = ''; clearFilters()">×</button>
          </div>

          <!-- 标签面板 -->
          <div v-if="searchOpen" class="popover" @click.stop>
            <div class="phead">
              <input ref="popFilter" v-model="tagFilter" placeholder="🔍 输入关键字快速过滤，如：猫、风景…" />
              <span class="pcount">{{ tagTotal }} 个标签</span>
            </div>
            <div class="pbody">
              <div v-for="g in tagGroups" :key="g.name" class="pgroup">
                <div class="pgname">{{ g.name }}<span v-if="g.disabled" class="off">（已停用）</span></div>
                <div v-for="t in g.items" :key="t.name" class="pitem" :class="{ on: selectedTags.includes(t.name) }" @click="toggleFilter(t.name)">
                  <span>{{ t.name }}<span v-if="g.name === '文档'" class="lock"> 🔒</span></span>
                  <span class="right"><span class="n">{{ t.count }} 张</span><span class="ck">{{ selectedTags.includes(t.name) ? '✓' : '' }}</span></span>
                </div>
              </div>
              <div v-if="!tagGroups.length" class="none">没有匹配「{{ tagFilter }}」的标签；回车可按关键字搜图</div>
            </div>
            <div class="pfoot">
              <span class="hint">点标签可多选 · 回车 = 按关键字搜图</span>
              <button class="primary sm" @click="searchOpen = false">完成</button>
            </div>
          </div>
        </div>

        <!-- 时间：收进一个下拉 -->
        <div class="datemenu">
          <button class="dbtn" :class="{ on: dateFrom || dateTo }" @click.stop="dateMenuOpen = !dateMenuOpen">
            📅 {{ dateLabel }} <span class="caret">▾</span>
          </button>
          <div v-if="dateMenuOpen" class="menu datepanel" @click.stop>
            <button class="mi" :class="{ on: !dateFrom && !dateTo }" @click="pickDate('')">不限</button>
            <button class="mi" :class="{ on: datePreset === 'month' }" @click="pickDate('month')">本月</button>
            <button class="mi" :class="{ on: datePreset === 'year' }" @click="pickDate('year')">今年</button>
            <div class="dr">
              <input type="date" v-model="dateFrom" @change="onDateChange" />
              <span>至</span>
              <input type="date" v-model="dateTo" @change="onDateChange" />
            </div>
          </div>
        </div>

        <div class="spacer" />

        <div class="importwrap">
          <button @click="doImportFolder" :disabled="importing">{{ importing ? '⏳ 导入中' : '📂 导入' }}</button>
          <button class="caret" @click.stop="moreOpen = !moreOpen">▾</button>
          <div v-if="moreOpen" class="menu" @click.stop>
            <button class="mi" @click="moreAction2(() => fileInput?.click())">🖼 选择图片文件…</button>
            <button class="mi" @click="moreAction2(doExport)">⤓ 导出当前筛选…</button>
          </div>
        </div>
        <input ref="fileInput" type="file" multiple accept="image/*" hidden @change="doImportFiles" />

        <button class="primary tagbtn" @click="openWizard" :disabled="tagging">{{ tagging ? '⏳ 分类中' : '✨ 开始分类' }}</button>
      </div>

      <!-- 已选条件行：只在有条件时出现；多标签时才出现 且/或 -->
      <div v-if="selectedTags.length || smart" class="filterrow">
        <span class="label">条件：</span>
        <span v-for="t in selectedTags" :key="t" class="chip auto">{{ t }} <i class="x" title="移除该条件" @click="removeFilter(t)">×</i></span>
        <span v-if="smart" class="chip auto">{{ smart }} <i class="x" title="移除该条件" @click="selectSmart(smart)">×</i></span>
        <div v-if="selectedTags.length >= 2" class="opseg">
          <button :class="{ on: op === 'and' }" @click="setOp('and')">同时满足</button>
          <button :class="{ on: op === 'or' }" @click="setOp('or')">任一满足</button>
        </div>
        <button class="clear" @click="clearFilters">清除全部</button>
      </div>

      <!-- 空状态 -->
      <div v-if="photos.length === 0 && !loading" class="empty">
        <div class="big">📷</div>
        <div class="t">{{ stats.total === 0 ? '还没有图片' : '没有符合条件的图片' }}</div>
        <button class="primary" @click="clearFilters">清除筛选</button>
      </div>

      <!-- 网格 -->
      <PhotoGrid v-else :photos="photos" :selected-ids="selectedIds" @open="openPhoto" @select="toggleSelect" @load-more="loadPhotos(false)" @reject="rejectPhotoTags" />

      <div v-if="loading" class="loading">⏳ 加载中…</div>

      <!-- 批量操作栏 -->
      <div v-if="selectedIds.size" class="batchbar">
        <span class="bc">已选 <b>{{ selectedIds.size }}</b> 张</span>
        <button class="primary" @click="batchAdd">＋ 加标签</button>
        <button :disabled="batchClassifying || tagging" title="对选中的图片重新跑本地分类（旧的自动标签会被替换，手动标签保留）"
          @click="batchReclassify">{{ batchClassifying ? '⏳ 分类中…' : '⚡ 重新分类' }}</button>
        <button class="aibtn" :disabled="tagging"
          :title="aiSettings.hasKey ? '把选中的图片送云端大模型重新打标（更准，会上传缩略图）' : '云端 AI 分类：需先在 分类设置 → AI 增强 配置 Key，点我将带你前往'"
          @click="batchAiClassify">🧠 AI 分类</button>
        <button @click="batchExport">⤓ 导出</button>
        <button class="danger" @click="batchDelete">🗑 删除</button>
        <button @click="clearSelect">取消</button>
      </div>

      <!-- 拖拽导入提示 -->
      <div v-if="dragging && view === 'home'" class="dropzone">📥 拖拽图片 / 文件夹到此处导入</div>
    </template>
  </template>

  <!-- 批量加标签对话框 -->
  <div v-if="batchTagOpen" class="mask" @click.self="batchTagOpen = false">
    <div class="dialog">
      <div class="dlg-head">为选中图片加标签</div>
      <div class="dlg-body">
        <p class="muted">输入标签名（多个用逗号分隔）：</p>
        <input v-model="batchTagName" placeholder="如：旅行, 风景" @keyup.enter="batchAddConfirm" />
      </div>
      <div class="dlg-foot">
        <button @click="batchTagOpen = false">取消</button>
        <button class="primary" @click="batchAddConfirm">添加</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 工具栏 ===== */
.toolbar { display: flex; gap: 10px; align-items: center; padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
.spacer { flex: 1; }

.searchwrap { position: relative; flex: 1; min-width: 220px; max-width: 560px; }
.smartbox { display: flex; align-items: center; gap: 6px; min-height: 40px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 4px 8px 4px 12px; cursor: text; transition: border-color .15s; flex-wrap: wrap; }
.smartbox.open, .smartbox:focus-within { border-color: var(--accent); }
.smartbox .sicon { font-size: 13px; opacity: .7; }
.smartbox input { flex: 1; min-width: 120px; border: none !important; background: transparent !important; padding: 6px 4px; }
.smartbox input:focus { border: none !important; }
.smartbox .clr { border: none; background: var(--surface); color: var(--muted); width: 22px; height: 22px; border-radius: 50%; padding: 0; font-size: 13px; line-height: 1; }
.smartbox .clr:hover { color: var(--danger); border-color: var(--border); }
.schip { background: var(--accent-soft); color: var(--accent); border-radius: 6px; padding: 3px 8px; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.schip i { cursor: pointer; font-style: normal; opacity: .7; }

.popover { position: absolute; top: calc(100% + 6px); left: 0; width: 460px; max-height: 460px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); z-index: 50; display: flex; flex-direction: column; overflow: hidden; }
.phead { padding: 10px 12px; border-bottom: 1px solid var(--border-2); display: flex; align-items: center; gap: 10px; }
.phead input { flex: 1; }
.pcount { color: var(--muted-2); font-size: 11px; white-space: nowrap; }
.pbody { overflow: auto; padding: 8px; flex: 1; }
.pgroup { margin-bottom: 4px; }
.pgname { font-size: 11px; font-weight: 600; color: var(--muted); padding: 6px 8px 3px; }
.pgname .off { color: var(--muted-2); font-weight: 400; }
.pitem { display: flex; justify-content: space-between; align-items: center; padding: 7px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.pitem:hover { background: var(--surface-2); }
.pitem.on { background: var(--accent-soft); color: var(--accent); }
.pitem .right { display: flex; align-items: center; gap: 6px; }
.pitem .n { color: var(--muted); font-size: 11px; }
.pitem .lock { color: var(--muted-2); font-size: 11px; }
.ck { width: 16px; height: 16px; border: 1.5px solid var(--border); border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; color: transparent; }
.pitem.on .ck { background: var(--accent); border-color: var(--accent); color: #fff; }
.pfoot { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-top: 1px solid var(--border-2); background: var(--surface-2); }
.pfoot .hint { color: var(--muted-2); font-size: 11px; }
.pfoot .sm { padding: 5px 14px; }
.none { color: var(--muted-2); font-size: 12px; padding: 8px; }

/* 时间下拉 */
.datemenu { position: relative; }
.dbtn { white-space: nowrap; }
.dbtn.on { border-color: var(--accent); color: var(--accent); }
.dbtn .caret { opacity: .6; font-size: 10px; }
.menu { position: absolute; top: calc(100% + 6px); right: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); z-index: 60; display: flex; flex-direction: column; min-width: 200px; overflow: hidden; }
.datepanel { right: 0; padding: 6px; }
.datepanel .mi { text-align: left; border: none; background: none; border-radius: 8px; padding: 9px 12px; }
.datepanel .mi:hover { background: var(--surface-2); }
.datepanel .mi.on { background: var(--accent-soft); color: var(--accent); }
.datepanel .dr { display: flex; align-items: center; gap: 6px; padding: 8px 10px 6px; border-top: 1px solid var(--border-2); margin-top: 4px; }
.datepanel .dr span { color: var(--muted); font-size: 12px; }
.datepanel .dr input { flex: 1; min-width: 0; font-size: 12px; padding: 5px 6px; }

.importwrap { position: relative; display: flex; }
.importwrap .caret { border-top-left-radius: 0; border-bottom-left-radius: 0; padding: 7px 8px; margin-left: -1px; }
.importwrap > button:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.tagbtn { font-weight: 700; }

/* 已选条件行（仅在有多条件时出现） */
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
.muted { color: var(--muted); }

.onboard { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; padding: 30px; }
.ob-title { font-size: 19px; font-weight: 700; color: var(--text); }
.ob-steps { display: flex; align-items: stretch; gap: 10px; }
.ob-step { width: 190px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 16px; display: flex; flex-direction: column; gap: 5px; text-align: left; position: relative; }
.ob-step .n { position: absolute; top: -10px; left: 14px; width: 22px; height: 22px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.ob-step .ic { font-size: 26px; }
.ob-step b { font-size: 14px; color: var(--text); }
.ob-step span { font-size: 12px; color: var(--muted); }
.ob-arrow { align-self: center; color: var(--muted-2); font-size: 18px; }
.ob-cta { font-size: 14px; padding: 10px 22px; }
.loading { text-align: center; color: var(--muted); font-size: 12px; padding: 10px; }

.batchbar { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 9px 14px; background: #202838; border: 1px solid var(--border); color: var(--text); border-radius: 12px; box-shadow: var(--shadow-lg); z-index: 60; }
.batchbar .bc { font-size: 13px; }
.batchbar .bc b { color: var(--accent); }
.batchbar button { border-color: var(--border); background: var(--surface-2); color: var(--text-2); }
.batchbar button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.batchbar button.aibtn { background: var(--vlm-soft); border-color: rgba(167, 139, 250, .4); color: var(--vlm); }
.batchbar button.aibtn:hover { border-color: var(--vlm); color: var(--vlm); }
.batchbar button.danger { color: var(--danger); }
.batchbar button:hover { border-color: var(--accent); color: var(--accent); }
.batchbar button.primary:hover { color: #fff; }
.batchbar button.danger:hover { color: var(--danger); }

.dropzone { position: absolute; inset: 12px; z-index: 70; border: 2px dashed var(--accent); border-radius: 16px; background: rgba(77, 141, 255, .08); display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 600; color: var(--accent); pointer-events: none; }

.mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .6); display: flex; align-items: center; justify-content: center; z-index: 100; }
.dialog { width: 440px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; box-shadow: var(--shadow-lg); }
.dlg-head { padding: 14px 16px; font-weight: 600; font-size: 14px; border-bottom: 1px solid var(--border-2); }
.dlg-body { padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; background: var(--surface-2); border-top: 1px solid var(--border-2); }
.dlg-foot button { width: auto; }

.search-head { display: flex; gap: 8px; align-items: center; padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--border-2); }
.sh-title { font-weight: 600; font-size: 14px; color: var(--text); }
.sh-input { flex: 0 1 280px; }
.sh-count { margin-left: auto; color: var(--muted); font-size: 12px; }
.search-body { flex: 1; display: flex; min-height: 0; }
.sug { width: 210px; min-width: 210px; border-right: 1px solid var(--border); padding: 12px 10px; overflow: auto; background: var(--surface); }
.sug .h { color: var(--muted-2); font-size: 11px; font-weight: 600; letter-spacing: .05em; margin: 4px 8px 8px; }
.st { display: flex; justify-content: space-between; align-items: center; padding: 7px 10px; border-radius: 8px; margin-bottom: 1px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.st:hover { background: var(--surface-2); }
.st.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.st .n { color: var(--muted); font-size: 11px; }
.sug .none { color: var(--muted-2); font-size: 12px; padding: 8px; }
.results { flex: 1; min-width: 0; display: flex; flex-direction: column; }
</style>
