<script setup>
import { useLibrary } from '../composables/useLibrary.js';

const { jobProgress, jobReport, stats, finishReport, goReview } = useLibrary();

const STATUS_TEXT = {
  queued: '排队中…',
  running: '处理中…',
  done: '完成',
  done_with_errors: '完成（有错误）',
  error: '失败',
};

function fmtSeconds(s) {
  return s == null ? '' : ` · 用时 ${s}s`;
}
</script>

<template>
  <!-- 分类报告：完成后停留，由用户选择去向 -->
  <div v-if="jobReport" class="pending-view">
    <template v-if="jobReport.ok">
      <div class="rp-icon">✅</div>
      <div class="rp-title">分类完成</div>
      <div class="rp-sub">
        {{ jobReport.kind === 'ai' ? '🧠 AI 增强' : '⚡ 本地模型' }} · 处理 {{ jobReport.stats.processed }} 张{{ fmtSeconds(jobReport.stats.seconds) }}
      </div>
      <div class="rp-cards">
        <div class="rp-card">
          <div class="n">{{ jobReport.stats.tagged ?? '—' }}</div>
          <div class="t">打上标签</div>
        </div>
        <div class="rp-card warn">
          <div class="n">{{ jobReport.stats.review != null ? stats.review : '—' }}</div>
          <div class="t">没把握，等你确认</div>
        </div>
      </div>
      <div class="rp-note" v-if="jobReport.stats.calibrated">已按你这批图自动校准了各组阈值。</div>
      <div class="rp-actions">
        <button v-if="(stats.review ?? 0) > 0" class="primary" @click="finishReport(); goReview()">
          去把关（{{ stats.review }} 张）→
        </button>
        <button @click="finishReport">返回图库</button>
      </div>
    </template>
    <template v-else>
      <div class="rp-icon">⚠️</div>
      <div class="rp-title">分类失败</div>
      <div class="rp-sub">{{ jobReport.error }}</div>
      <div class="rp-actions">
        <button class="primary" @click="finishReport">返回图库</button>
      </div>
    </template>
  </div>

  <!-- 进行中：进度条 -->
  <div v-else class="pending-view">
    <div class="pv-head">
      <span class="pv-title">✨ 正在分类</span>
      <span class="pv-status" :class="jobProgress.status">
        {{ STATUS_TEXT[jobProgress.status] || jobProgress.status }}
      </span>
    </div>
    <div class="pv-bar">
      <div class="pv-fill" :style="{ width: (jobProgress.total ? Math.round(jobProgress.done / jobProgress.total * 100) : 0) + '%' }" />
    </div>
    <div class="pv-count">{{ jobProgress.total ? `${jobProgress.done} / ${jobProgress.total}` : '准备中…' }} 张</div>
    <div v-if="jobProgress.error" class="pv-error">⚠️ {{ jobProgress.error }}</div>
    <div class="pv-grid">
      <div v-for="n in Math.min(jobProgress.total || 12, 24)" :key="n" class="pv-cell" :class="{ done: n <= jobProgress.done }" />
    </div>
  </div>
</template>

<style scoped>
.pending-view { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 30px; }
.pv-head { display: flex; align-items: center; gap: 12px; }
.pv-title { font-size: 17px; font-weight: 700; color: var(--text); }
.pv-status { font-size: 13px; color: var(--muted); }
.pv-status.running { color: var(--accent); }
.pv-status.done, .pv-status.done_with_errors { color: var(--ok); }
.pv-status.error { color: var(--danger); }
.pv-bar { width: min(520px, 80%); height: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
.pv-fill { height: 100%; background: linear-gradient(90deg, var(--accent), #60a5fa); transition: width .3s; }
.pv-count { font-size: 13px; color: var(--muted); }
.pv-error { font-size: 12px; color: var(--danger); max-width: 80%; word-break: break-all; }
.pv-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 8px; margin-top: 8px; }
.pv-cell { aspect-ratio: 1; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); }
.pv-cell.done { background: var(--accent-soft); border-color: var(--accent-border); }

.rp-icon { font-size: 44px; }
.rp-title { font-size: 19px; font-weight: 700; color: var(--text); }
.rp-sub { font-size: 13px; color: var(--muted); }
.rp-cards { display: flex; gap: 14px; margin-top: 6px; }
.rp-card { background: var(--accent-soft); border: 1px solid var(--accent-border); border-radius: 14px; padding: 14px 26px; text-align: center; }
.rp-card.warn { background: var(--warn-soft); border-color: #fde68a; }
.rp-card .n { font-size: 26px; font-weight: 700; color: var(--accent); }
.rp-card.warn .n { color: var(--warn); }
.rp-card .t { font-size: 12px; color: var(--muted); margin-top: 2px; }
.rp-note { font-size: 12px; color: var(--muted); }
.rp-actions { display: flex; gap: 10px; margin-top: 8px; }
</style>
