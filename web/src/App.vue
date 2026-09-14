<script setup>
import { onMounted } from 'vue';
import TagPanel from './components/TagPanel.vue';
import Lightbox from './components/Lightbox.vue';
import Home from './views/Home.vue';
import Progress from './views/Progress.vue';
import Review from './views/Review.vue';
import Settings from './views/Settings.vue';
import Vocab from './views/Vocab.vue';
import Wizard from './views/Wizard.vue';
import { useLibrary } from './composables/useLibrary.js';

const {
  stats, info, vocab, sourceTags, countMap,
  view, selected, selectedIndex, photos,
  selectedTags, smart,
  dragging, toast, confirmOpen, confirmMsg,
  reclassifying, aiReclassifying, reclassifyCurrent, reclassifyCurrentAi,
  aiSettings,
  onDrop, toggleFilter, selectSmart, goHome, navTo,
  openPhoto, step, applyTagChange, onDeletePhoto, resetToUnclassified,
  closePhoto, confirmYes, loadInfo, loadVocab, loadStats, loadPhotos, loadAiSettings,
} = useLibrary();

onMounted(() => { loadInfo(); loadVocab(); loadStats(); loadPhotos(true); loadAiSettings(); });
</script>

<template>
  <!-- 标题栏 -->
  <div class="titlebar">
    <span class="dot" style="background:#f87171" /><span class="dot" style="background:#fbbf24" /><span class="dot" style="background:#34d399" />
    <span class="tb-title">本地图库</span>
    <span class="tb-right">{{ stats.total }} 张{{ stats.unclassified ? ` · 还没分类 ${stats.unclassified}` : '' }}<template v-if="stats.review"> · 没把握 {{ stats.review}}</template></span>
  </div>

  <div class="appshell">
    <!-- 侧栏 -->
    <TagPanel
      :vocab="vocab" :source-tags="sourceTags" :count-map="countMap" :stats="stats"
      :selected-tags="selectedTags" :smart="smart" :view="view"
      @toggle="toggleFilter" @smart="selectSmart" @home="goHome" @nav="navTo"
      :model-ready="info.modelReady"
    />

    <!-- 主区域 -->
    <section class="main"
      @dragover.prevent="dragging = (view === 'home')"
      @dragenter.prevent="dragging = (view === 'home')"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop">
      <!-- 灯箱视图 -->
      <Lightbox
        v-if="view === 'light' && selected"
        :photo="selected" :vocab="vocab" :source-tags="sourceTags"
        :has-prev="selectedIndex > 0" :has-next="selectedIndex >= 0 && selectedIndex < photos.length - 1"
        :reclassifying="reclassifying"
        :ai-reclassifying="aiReclassifying"
        :ai-ready="aiSettings.enabled && aiSettings.hasKey"
        @close="closePhoto" @prev="step(-1)" @next="step(1)" @change="applyTagChange"
        @delete="onDeletePhoto" @reclassify="reclassifyCurrent" @reclassify-ai="reclassifyCurrentAi" @reset="resetToUnclassified"
      />

      <!-- 分类进度 / 报告 -->
      <Progress v-else-if="view === 'pending'" />

      <!-- 待确认审阅 -->
      <Review v-else-if="view === 'review'" />

      <!-- 设置页 -->
      <Settings v-else-if="view === 'settings'" />

      <!-- 词表页 -->
      <Vocab v-else-if="view === 'vocab'" />

      <!-- 网格 / 搜索 -->
      <Home v-else />
    </section>
  </div>

  <!-- 分类向导 -->
  <Wizard />

  <!-- 通用确认对话框 -->
  <div v-if="confirmOpen" class="mask" @click.self="confirmOpen = false">
    <div class="dialog">
      <div class="dlg-head">确认操作</div>
      <div class="dlg-body"><p class="muted">{{ confirmMsg }}</p></div>
      <div class="dlg-foot">
        <button @click="confirmOpen = false">取消</button>
        <button class="danger" @click="confirmYes">删除</button>
      </div>
    </div>
  </div>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>

<style scoped>
.titlebar { height: 38px; background: var(--surface); display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.dot { width: 10px; height: 10px; border-radius: 50%; }
.tb-title { font-size: 13px; font-weight: 600; color: var(--text-2); margin-left: 4px; }
.tb-right { margin-left: auto; color: var(--muted); font-size: 12px; }

.appshell { display: flex; flex: 1; overflow: hidden; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); position: relative; }

.mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .6); display: flex; align-items: center; justify-content: center; z-index: 100; }
.dialog { width: 440px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; box-shadow: var(--shadow-lg); }
.dlg-head { padding: 14px 16px; font-weight: 600; font-size: 14px; border-bottom: 1px solid var(--border-2); }
.dlg-body { padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; background: var(--surface-2); border-top: 1px solid var(--border-2); }
.dlg-foot button { width: auto; }
.muted { color: var(--muted); }

.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #222b3c; border: 1px solid var(--border); color: var(--text); padding: 9px 16px; border-radius: 10px; font-size: 13px; z-index: 200; box-shadow: var(--shadow-lg); max-width: 80vw; }
</style>
