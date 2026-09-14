<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { api } from '../api.js';
import { useLibrary } from '../composables/useLibrary.js';

const {
  info, vocab, autoTagAfterImport, persistPrefs, notify, goHome,
  toggleGroup, aiSettings, saveAi, runAiTest, aiTesting,
} = useLibrary();

/* ========= 自动分类 =========
   用户模型：打得多准（三档）→ 模型能打哪些标签（组开关）→ 顺手项
   阈值数字/分组阈值/目录路径 = 系统模型，收进「高级」折叠 */
const TIERS = [
  { label: '宽松', value: 0.21, desc: '宁可多打，适合先粗筛一遍' },
  { label: '标准', value: 0.24, desc: '推荐。大多数图能得到 1~4 个可靠标签' },
  { label: '严格', value: 0.27, desc: '宁可漏打；没把握的都进「待确认」由你拍板' },
];
const thresholdInput = ref(0.24);
const tierActive = computed(() => TIERS.find((t) => t.value === Number(thresholdInput.value)) || null);
const tierDesc = computed(() => tierActive.value?.desc || '自定义把握要求');
const showAdvanced = ref(false);

const preview = ref(null);
let previewTimer = null;
watch(thresholdInput, (v) => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try { preview.value = await api.tagPreview(Number(v)); } catch { preview.value = null; }
  }, 250);
}, { immediate: true });

const autoGroups = computed(() => (vocab.value || []).filter((g) => g.kind === 'auto'));
const onCount = computed(() => autoGroups.value.filter((g) => !g.disabled).length);

onMounted(async () => {
  try { const r = await api.getSettings(); thresholdInput.value = r.threshold; } catch {}
});

async function saveThreshold() {
  try {
    const r = await api.saveSettings(Number(thresholdInput.value));
    thresholdInput.value = r.threshold;
    notify('已保存。下次「开始分类」时生效');
  } catch (e) { notify('保存失败：' + e.message); }
}

/* ========= AI 增强 =========
   用户模型：要不要用云端 → 填 Key → 测通就行
   服务商/模型名/BaseURL/隐私例外 = 高级，内联展开 */
const aiForm = ref({ provider: 'dashscope', model: '', baseUrl: '', apiKey: '', allowPrivateGroups: false, enabled: false });
const aiTestResult = ref(null);
const aiAdvanced = ref(false);
watch(aiSettings, (s) => {
  aiForm.value = {
    provider: s.provider || 'dashscope',
    model: s.model || '',
    baseUrl: s.baseUrl || '',
    apiKey: '',
    allowPrivateGroups: !!s.allowPrivateGroups,
    enabled: !!s.enabled,
  };
}, { immediate: true });

const aiState = computed(() => {
  if (!aiSettings.value.hasKey) return { tone: 'idle', text: '未配置。配置后可把「没把握」的照片交给云端大模型复判，比本地更准。' };
  if (!aiSettings.value.enabled) return { tone: 'warn', text: `已配置 Key（${aiSettings.value.keyMasked}），但开关未打开。` };
  return { tone: 'ok', text: `已启用（${aiSettings.value.model || '默认模型'}）。只有你确认要增强的照片才会上传。` };
});

async function saveAiSettings() {
  const patch = { ...aiForm.value };
  if (!patch.apiKey.trim()) delete patch.apiKey;
  const r = await saveAi(patch);
  if (r.ok) { aiForm.value.apiKey = ''; notify('AI 设置已保存'); }
}
async function testAi() {
  await saveAiSettings();
  aiTestResult.value = await runAiTest();
  notify(aiTestResult.value.ok ? '连接成功 ✔' : `连接失败：${aiTestResult.value.error?.slice(0, 80)}`);
}
</script>

<template>
  <div class="page">
    <h2>分类设置</h2>

    <!-- ===== 自动分类 ===== -->
    <section class="block">
      <div class="bt">⚡ 自动分类</div>
      <div class="state" :class="info.modelReady ? 'ok' : 'warn'">
        {{ info.modelReady ? '本地模型已就绪，图片不会离开你的电脑。' : '本地模型还没下载：第一次点「开始分类」时会自动下载（约 150MB），之后离线可用。' }}
      </div>

      <div class="field">
        <div class="fl">打标多准</div>
        <div class="tiers">
          <button v-for="t in TIERS" :key="t.label" :class="{ on: t.value === Number(thresholdInput) }" @click="thresholdInput = t.value">{{ t.label }}</button>
        </div>
        <div class="fd">{{ tierDesc }}</div>
        <div v-if="preview" class="fd muted">按当前选择，已打标的 {{ preview.taggedPhotos }} 张里约 <b>{{ preview.keepPhotos }}</b> 张能保住标签，其余进「待确认」。保存后下次分类生效。</div>
        <div class="acts"><button class="primary" @click="saveThreshold">保存</button></div>
      </div>

      <div class="field">
        <div class="fl">模型自动打的标签范围</div>
        <div class="groups">
          <label v-for="g in autoGroups" :key="g.name" class="gswitch" :title="g.disabled ? '已停用：模型不会自动打这组' : '开启中'">
            <input type="checkbox" :checked="!g.disabled" @change="toggleGroup(g)" />
            <span>{{ g.name }}</span>
          </label>
        </div>
        <div class="fd muted">已开启 {{ onCount }}/{{ autoGroups.length }} 组。想增加/删除某个标签，去「标签管理」。</div>
      </div>

      <div class="field row">
        <label class="checkline"><input type="checkbox" v-model="autoTagAfterImport" @change="persistPrefs" /> 新图片导入后自动开始分类</label>
      </div>

      <details class="adv" :open="showAdvanced" @toggle="showAdvanced = $event.target.open">
        <summary>高级</summary>
        <div class="field"><div class="fl">把握要求（数值）</div>
          <div class="tiers"><input type="number" step="0.01" min="0" max="1" v-model.number="thresholdInput" /><button @click="saveThreshold">保存</button></div>
        </div>
        <div class="field"><div class="fl">收件箱目录</div><div class="mono">{{ info.inboxDir }}</div></div>
        <div class="field"><div class="fl">词表文件</div><div class="mono">{{ info.tagsFile }}</div></div>
      </details>
    </section>

    <!-- ===== AI 增强 ===== -->
    <section class="block">
      <div class="bt">🧠 AI 增强（云端，可选）</div>
      <div class="state" :class="aiState.tone">{{ aiState.text }}</div>

      <div class="field row"><label class="checkline"><input type="checkbox" v-model="aiForm.enabled" /> 启用 AI 增强</label></div>

      <template v-if="aiForm.enabled">
        <div class="field">
          <div class="fl">API Key</div>
          <div class="krow">
            <input v-model="aiForm.apiKey" type="password" class="grow"
              :placeholder="aiSettings.hasKey ? `已保存（${aiSettings.keyMasked}），留空表示不修改` : '粘贴服务商控制台里的 Key'" />
            <button class="primary" @click="saveAiSettings">保存</button>
            <button :disabled="aiTesting" @click="testAi">{{ aiTesting ? '测试中…' : '测试连接' }}</button>
          </div>
          <div v-if="aiTestResult" class="fd" :class="aiTestResult.ok ? 'ok' : 'err'">
            {{ aiTestResult.ok ? '✔ 连接成功，可以用了' : `✗ 连不上：${aiTestResult.error}。请检查 Key 和网络后重试。` }}
          </div>
          <div class="fd muted">Key 只存在这台电脑上（data/settings.json），不会出现在任何界面里。</div>
        </div>

        <details class="adv" :open="aiAdvanced" @toggle="aiAdvanced = $event.target.open">
          <summary>高级选项</summary>
          <div class="field row">
            <div class="fl">服务商</div>
            <select v-model="aiForm.provider" class="sel">
              <option value="dashscope">阿里云百炼 Qwen-VL</option>
              <option value="openai">OpenAI 兼容接口</option>
            </select>
          </div>
          <div class="field row">
            <div class="fl">模型名</div>
            <input v-model="aiForm.model" :placeholder="aiForm.provider === 'dashscope' ? '默认 qwen-vl-max' : '如 gpt-4o-mini'" class="grow" />
          </div>
          <div class="field row" v-if="aiForm.provider === 'openai'">
            <div class="fl">接口地址</div>
            <input v-model="aiForm.baseUrl" placeholder="默认 https://api.openai.com/v1" class="grow" />
          </div>
          <div class="field row">
            <label class="checkline"><input type="checkbox" v-model="aiForm.allowPrivateGroups" /> 允许把「证件 / 发票」类照片也送云端（默认不送）</label>
          </div>
        </details>
        <div class="fd muted">上传的只是该张图片的缩略图；模型只允许从你的标签清单里选词，不会发明新标签。</div>
      </template>
    </section>

    <button @click="goHome">返回图库</button>
  </div>
</template>

<style scoped>
.page { flex: 1; overflow: auto; padding: 24px 28px; }
.page h2 { font-size: 18px; margin-bottom: 16px; color: var(--text); }
.block { max-width: 720px; margin-bottom: 18px; }
.bt { font-size: 15px; font-weight: 700; margin-bottom: 10px; }
.state { font-size: 13px; border-left: 3px solid var(--muted-2); padding: 6px 12px; margin-bottom: 16px; color: var(--text-2); background: var(--surface-2); border-radius: 0 8px 8px 0; }
.state.ok { border-color: var(--ok); }
.state.warn { border-color: var(--warn); }
.state.idle { border-color: var(--muted-2); }

.field { margin-bottom: 18px; }
.fl { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.fd { font-size: 12.5px; color: var(--text-2); margin-top: 8px; }
.fd.muted, .muted { color: var(--muted); }
.fd.ok { color: var(--ok); }
.fd.err { color: var(--danger); }
.row { display: flex; align-items: center; }

.tiers { display: flex; gap: 8px; }
.tiers button { padding: 8px 22px; font-size: 13px; border-radius: 10px; }
.tiers button.on { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.groups { display: flex; flex-wrap: wrap; gap: 8px; }
.gswitch { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 999px; padding: 5px 12px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.gswitch:hover { border-color: var(--accent-border); }
.acts { margin-top: 10px; }
.checkline { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); cursor: pointer; }
.krow { display: flex; gap: 8px; }
.krow .grow { flex: 1; min-width: 200px; }
.sel { min-width: 200px; }
.grow { flex: 1; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); word-break: break-all; }

.adv { margin-top: 14px; border-top: 1px dashed var(--border); padding-top: 10px; }
.adv summary { cursor: pointer; color: var(--muted); font-size: 12.5px; user-select: none; }
.adv summary:hover { color: var(--accent); }
.adv[open] summary { margin-bottom: 12px; }
.page > button { margin-top: 8px; }
</style>
