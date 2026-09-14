<script setup>
import { computed } from 'vue';
import { useLibrary } from '../composables/useLibrary.js';

const {
  stats, wizardOpen, wizardScope, wizardMode, aiSettings,
  startWizard, navTo,
} = useLibrary();

const newCount = computed(() => stats.value.unclassified ?? 0);
const reviewCount = computed(() => stats.value.review ?? 0);
const aiReady = computed(() => aiSettings.value.hasKey);

const scopes = computed(() => [
  { key: 'new', label: '只分新图片', sub: `约 ${newCount.value} 张还没分`, disabled: newCount.value === 0 },
  { key: 'all', label: '全部重新分', sub: `清掉现有自动标签，${stats.value.total} 张重跑（人工标签保留）` },
]);
</script>

<template>
  <div v-if="wizardOpen" class="mask" @click.self="wizardOpen = false">
    <div class="wizard">
      <div class="dlg-head">开始分类</div>
      <div class="dlg-body">
        <div class="sec">
          <div class="q">① 分哪些？</div>
          <div class="opts">
            <button v-for="s in scopes" :key="s.key" class="opt" :class="{ on: wizardScope === s.key }"
              :disabled="s.disabled" @click="wizardScope = s.key">
              <b>{{ s.label }}</b><span>{{ s.sub }}</span>
            </button>
          </div>
        </div>

        <div class="sec">
          <div class="q">② 怎么分？</div>
          <div class="opts">
            <button class="opt" :class="{ on: wizardMode === 'local' }" @click="wizardMode = 'local'">
              <b>⚡ 本地快速（推荐）</b>
              <span>秒级 · 离线 · <b class="safe">图片不离开电脑</b></span>
              <span>对照固定词表给每张图打 1~4 个标签</span>
            </button>
            <button class="opt" :class="{ on: wizardMode === 'ai' }" @click="wizardMode = 'ai'">
              <b>🧠 AI 增强（可选）</b>
              <span v-if="aiReady">把「没把握」的照片送云端大模型复判 · 更准</span>
              <span v-else class="need">需先在设置里配置 API Key</span>
              <span v-if="aiReady" class="up">上传的只有选中的缩略图</span>
            </button>
          </div>
          <button v-if="wizardMode === 'ai' && !aiReady" class="link" @click="wizardOpen = false; navTo('settings')">
            → 去设置里配置 AI 增强
          </button>
        </div>

        <div class="expect">
          预计：每张图打 1~4 个标签；<b>没把握的会进「待确认」，由你拍板</b>，你的纠正会让它越来越准。
        </div>
      </div>
      <div class="dlg-foot">
        <button @click="wizardOpen = false">取消</button>
        <button class="primary" :disabled="wizardMode === 'ai' && !aiReady" @click="startWizard">开始 →</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .6); display: flex; align-items: center; justify-content: center; z-index: 120; }
.wizard { width: 560px; max-height: 86vh; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-lg); }
.dlg-head { padding: 14px 18px; font-weight: 700; font-size: 15px; border-bottom: 1px solid var(--border-2); }
.dlg-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.sec .q { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 8px; }
.opts { display: flex; gap: 10px; }
.opt { flex: 1; text-align: left; display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; border-radius: 12px; border: 1.5px solid var(--border); background: var(--surface-2); }
.opt:hover { border-color: var(--accent-border); color: inherit; }
.opt.on { border-color: var(--accent); background: var(--accent-soft); }
.opt b { font-size: 13px; color: var(--text); }
.opt span { font-size: 11.5px; color: var(--muted); }
.opt .safe { color: var(--ok); }
.opt .need { color: var(--warn); }
.opt .up { color: var(--muted); }
.opt:disabled { opacity: .45; }
.link { border: none; background: none; color: var(--accent); padding: 0; font-size: 12px; text-align: left; }
.expect { background: var(--surface-2); border-radius: 10px; padding: 10px 12px; font-size: 12px; color: var(--text-2); }
.dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; background: var(--surface-2); border-top: 1px solid var(--border-2); border-radius: 0 0 14px 14px; }
</style>
