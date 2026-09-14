// 共享图库状态与动作（单例 composable）：App 壳、Home / Progress / Review / Settings / Vocab / Wizard 共同引用。
import { ref, computed } from 'vue';
import { api } from '../api.js';

const info = ref({ inboxDir: '', modelReady: false });
const vocab = ref([]);
const sourceTags = ref([]);
const countMap = ref({});
const stats = ref({ total: 0, pending: 0, inbox: 0, unclassified: 0, dup: 0, review: 0, doc: 0 });

const view = ref('home');          // 'home' | 'light' | 'pending' | 'search' | 'settings' | 'vocab' | 'review'
const selectedTags = ref([]);      // 筛选标签名
const tagFilter = ref('');
const searchQuery = ref('');
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

const importing = ref(false);
const dragging = ref(false);

// 多选（Ctrl/⌘+点击）
const selectedIds = ref(new Set());

const tagging = ref(false);
const exporting = ref(false);

// 分类进度（异步 job 轮询）+ 完成后的分类报告
const jobId = ref(null);
const jobProgress = ref({ status: '', total: 0, done: 0, error: null, stats: null });
const jobReport = ref(null);       // 完成后停在进度视图展示报告，由用户选择去向
let jobTimer = null;

// 分类向导
const wizardOpen = ref(false);
const wizardScope = ref('new');    // 'new' 只分新图片 | 'all' 全部重新分
const wizardMode = ref('local');   // 'local' 本地快速 | 'ai' AI 增强（送待确认）

// 待确认审阅流
const reviewItems = ref([]);
const reviewIdx = ref(-1);
const reviewLoading = ref(false);

// AI 增强（云端 VLM）设置
const aiSettings = ref({ provider: 'dashscope', model: '', enabled: false, hasKey: false, keyMasked: '', allowPrivateGroups: false });
const aiTesting = ref(false);

const toast = ref(null);
let toastTimer = null;

// 通用确认对话框
const confirmOpen = ref(false);
const confirmMsg = ref('');
let confirmAction = null;

// 导入后自动分类（本地偏好）
const autoTagAfterImport = ref(localStorage.getItem('tagger.autoTag') === '1');

// ---- toast / 确认 ----
function notify(msg) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), 3000);
}
function askConfirm(msg, action) { confirmMsg.value = msg; confirmAction = action; confirmOpen.value = true; }
function confirmYes() {
  const a = confirmAction;
  confirmOpen.value = false;
  confirmAction = null;
  if (a) a();
}

// 错误文案：说清发生了什么、数据是否安全、下一步做什么（技术细节不进 toast）
function humanizeError(e) {
  const m = String(e?.message ?? e ?? '');
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|NetworkError|getaddrinfo/i.test(m)) {
    return '网络连不上。首次分类需要联网下载模型（约 150MB），之后离线可用——请检查网络后重试；你的图片和已打的标签不受影响。';
  }
  if (/EADDRINUSE/i.test(m)) return '服务端口被占用，可能已经开了一个图库窗口。关掉旧的再试。';
  if (/MODULE_NOT_FOUND|Cannot find module/i.test(m)) return '程序文件不完整，请重新执行 npm install 后再试。';
  if (/request body too large/i.test(m)) return '有单个文件太大传不上去，试试导入文件夹的方式。';
  return `${m}。你的图片和数据不受影响，可以直接重试；若反复出现，把这条信息发给开发者。`;
}

// ---- 数据加载 ----
async function loadInfo() { try { info.value = await api.info(); } catch {} }
async function loadVocab() {
  const r = await api.tags();
  vocab.value = r.vocab; sourceTags.value = r.sourceTags; countMap.value = r.countMap;
}
async function loadStats() { stats.value = await api.stats(); }
async function loadAiSettings() { try { aiSettings.value = await api.aiSettings(); } catch {} }

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

// ---- 拖拽导入：从系统拖入文件/文件夹，松开自动上传入库 ----
async function onDrop(e) {
  if (view.value !== 'home') return;
  dragging.value = false;
  const dt = e.dataTransfer;
  if (!dt) return;
  let files = [];
  try { files = await collectDropFiles(dt); } catch { files = []; }
  if (!files.length) { notify('未识别到可导入的文件'); return; }
  importing.value = true;
  try {
    const res = await api.importFiles(files);
    reportImport(res.stats, res.failed);
    await loadInfo();
  } catch (err) { notify('拖拽导入失败：' + err.message); }
  finally { importing.value = false; }
}

async function collectDropFiles(dt) {
  const items = dt.items;
  const files = [];
  if (items && items.length && items[0] && items[0].webkitGetAsEntry) {
    const entries = [];
    for (const it of items) {
      const entry = it.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    for (const entry of entries) {
      if (entry.isFile) files.push(await fileFromEntry(entry));
      else if (entry.isDirectory) await walkDir(entry, files);
    }
  } else {
    for (const f of dt.files) files.push(f);
  }
  return files.filter((f) => /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name || ''));
}

function fileFromEntry(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}
function walkDir(dirEntry, out) {
  return new Promise((resolve) => {
    const reader = dirEntry.createReader();
    const readBatch = () => {
      reader.readEntries(async (entries) => {
        if (!entries.length) { resolve(); return; }
        for (const e of entries) {
          if (e.isFile) out.push(await fileFromEntry(e));
          else if (e.isDirectory) await walkDir(e, out);
        }
        readBatch();
      }, () => resolve());
    };
    readBatch();
  });
}

// ---- 多选 ----
function toggleSelect(id) {
  const s = new Set(selectedIds.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  selectedIds.value = s;
}
function clearSelect() { selectedIds.value = new Set(); }

// ---- 计算属性 ----
// 分组后的标签（popover 用）
const tagGroups = computed(() => {
  const groups = [];
  for (const g of vocab.value) {
    if (g.disabled) continue; // 关闭的组不再参与筛选入口
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
  q: view.value === 'search' ? (searchQuery.value.trim() || undefined) : undefined,
}));

// 搜索建议词（按计数排序，匹配 searchQuery）
const suggestionTags = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  return Object.entries(countMap.value || {})
    .filter(([name, c]) => c > 0 && (!q || name.toLowerCase().includes(q)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);
});

// ---- 搜索 / 筛选 ----
// 任何筛选/相册动作都应离开灯箱、词表、设置等视图，回到图库——否则"点了没反应"
function exitToGrid() {
  if (['light', 'vocab', 'settings', 'review'].includes(view.value)) view.value = 'home';
}

function runSearch() {
  if (!searchQuery.value.trim()) return;
  smart.value = null;
  selectedTags.value = [];
  view.value = 'search';
  loadPhotos(true);
}

// 点某个标签直接筛选（词表页/灯箱标签点击用）
function filterByTag(name) {
  smart.value = null;
  selectedTags.value = [name];
  view.value = 'home';
  loadPhotos(true);
}

function toggleFilter(name) {
  exitToGrid();
  const i = selectedTags.value.indexOf(name);
  if (i >= 0) selectedTags.value.splice(i, 1);
  else selectedTags.value.push(name);
  loadPhotos(true);
}
function removeFilter(name) { selectedTags.value = selectedTags.value.filter((x) => x !== name); loadPhotos(true); }
function clearFilters() {
  exitToGrid();
  selectedTags.value = []; smart.value = null; dateFrom.value = ''; dateTo.value = '';
  loadPhotos(true);
}
function goHome() {
  smart.value = null; selectedTags.value = []; dateFrom.value = ''; dateTo.value = '';
  view.value = 'home';
  loadPhotos(true);
}

// 日期快捷筛选
const datePreset = ref('');
function onDateChange() { datePreset.value = ''; exitToGrid(); loadPhotos(true); }
function setDatePreset(kind) {
  const now = new Date();
  if (kind === 'month') {
    dateFrom.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    dateTo.value = '';
    datePreset.value = 'month';
  } else if (kind === 'year') {
    dateFrom.value = `${now.getFullYear()}-01-01`;
    dateTo.value = '';
    datePreset.value = 'year';
  } else {
    dateFrom.value = ''; dateTo.value = ''; datePreset.value = '';
  }
  exitToGrid();
  loadPhotos(true);
}
function selectSmart(name) {
  smart.value = smart.value === name ? null : name;
  if (smart.value) selectedTags.value = [];
  if (smart.value === 'review') { goReview(); return; }
  exitToGrid();
  loadPhotos(true);
}
function setOp(v) { op.value = v; exitToGrid(); loadPhotos(true); }

// ---- 灯箱（主区域视图切换）----
async function openPhoto(id) {
  selected.value = await api.photo(id);
  selectedIndex.value = photos.value.findIndex((p) => p.id === id);
  view.value = 'light';
}

// 单图重新分类：清除该图旧 CLIP 标签后用模型重新打分（无论是否已分类）
const reclassifying = ref(false);
async function reclassifyCurrent() {
  if (!selected.value || reclassifying.value) return;
  reclassifying.value = true;
  try {
    const r = await api.reclassify(selected.value.id);
    selected.value = await api.photo(selected.value.id);
    const item = photos.value.find((p) => p.id === selected.value.id);
    if (item) item.tags = selected.value.tags;
    await Promise.all([loadVocab(), loadStats()]);
    notify(`重新分类完成，命中 ${r.tagged} 个标签${r.review ? `，另有 ${r.review} 个待确认` : ''}`);
  } catch (e) {
    notify(humanizeError(e).replace('网络连不上', '分类失败：网络连不上'));
  } finally {
    reclassifying.value = false;
  }
}

// 单图 AI 增强（云端 VLM）重新分类
const aiReclassifying = ref(false);
async function reclassifyCurrentAi() {
  if (!selected.value || aiReclassifying.value) return;
  aiReclassifying.value = true;
  try {
    const r = await api.reclassifyVlm(selected.value.id);
    selected.value = await api.photo(selected.value.id);
    const item = photos.value.find((p) => p.id === selected.value.id);
    if (item) item.tags = selected.value.tags;
    await Promise.all([loadVocab(), loadStats()]);
    notify(`AI 增强完成，打上 ${r.tagged} 个标签（来源已标 🧠）`);
  } catch (e) {
    notify('AI 增强失败：' + humanizeError(e));
  } finally {
    aiReclassifying.value = false;
  }
}
function closePhoto() { view.value = 'home'; selected.value = null; selectedIndex.value = -1; }
// 重置为未分类：清空该图所有标签（保留在库），随后它会出现在「未分类」相册
function resetToUnclassified() {
  if (!selected.value) return;
  const id = selected.value.id;
  const name = selected.value.path;
  askConfirm(`确定把「${name}」重置为未分类吗？会清空它的全部标签（自动/手动/规则），但图片仍留在图库，可重新分类。`, async () => {
    try {
      await api.resetTags(id);
      selected.value = await api.photo(id);
      const item = photos.value.find((p) => p.id === id);
      if (item) item.tags = selected.value.tags;
      await Promise.all([loadVocab(), loadStats(), loadPhotos(true)]);
      notify('已重置为未分类');
    } catch (e) { notify('重置失败：' + e.message); }
  });
}
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

// 网格快捷反馈：驳回错误标签（后端记反馈并自动抬高该标签阈值）
async function rejectPhotoTags(id, names) {
  if (!names?.length) return;
  await api.setTags(id, [], names);
  const item = photos.value.find((p) => p.id === id);
  if (item) item.tags = item.tags.filter((t) => !names.includes(t.name) || t.source === 'manual');
  await loadStats();
  notify(`已移除 ${names.length} 个标签，模型会记住这个纠正`);
}

// 从库删除（只删索引+缩略图，不动原图）
function onDeletePhoto() {
  if (!selected.value) return;
  const id = selected.value.id;
  const name = selected.value.path;
  askConfirm(`确定从图库删除「${name}」的索引与缩略图吗？原图文件不会被删除。`, async () => {
    try {
      await api.deletePhoto(id);
      photos.value = photos.value.filter((p) => p.id !== id);
      closePhoto();
      notify('已从图库移除');
      loadStats(); loadVocab();
    } catch (e) { notify('删除失败：' + e.message); }
  });
}

// ---- 导入 ----
async function doImportFolder() {
  if (importing.value) return;
  importing.value = true;
  try {
    const r = await api.browse();
    const dir = r?.dir;
    if (!dir) { notify('未选择目录'); return; }
    const res = await api.import(dir);
    reportImport(res.stats, res.failed);
    await loadInfo();
  } catch (e) { notify('导入失败：' + e.message); }
  finally { importing.value = false; }
}

async function doImportFiles(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  importing.value = true;
  try {
    const res = await api.importFiles(files);
    reportImport(res.stats, res.failed);
    await loadInfo();
  } catch (e) { notify('导入失败：' + e.message); }
  finally { importing.value = false; e.target.value = ''; }
}

function reportImport(s, failed = []) {
  const parts = [`新增 ${s.new ?? 0}`];
  if (s.updated) parts.push(`更新 ${s.updated}`);
  if (s.dup) parts.push(`重复 ${s.dup}`);
  if (s.video) parts.push(`视频 ${s.video}（暂不支持，已跳过）`);
  if (s.failed) {
    parts.push(`失败 ${s.failed}`);
    notify(`导入完成：${parts.join('，')}。第一个失败原因：${(failed && failed[0]) || '未知'}；其他图片不受影响。`);
  } else {
    notify(`导入完成：${parts.join('，')}`);
  }
  reportImportDone();
}

function reportImportDone() {
  loadPhotos(true); loadStats(); loadVocab();
  if (autoTagAfterImport.value && info.value.modelReady) openWizard();
}

// ---- 分类向导 ----
function openWizard() {
  wizardScope.value = 'new';
  wizardMode.value = 'local';
  if (!aiSettings.value.hasKey) wizardMode.value = 'local';
  wizardOpen.value = true;
}

async function startWizard() {
  wizardOpen.value = false;
  if (wizardMode.value === 'ai') {
    if (!aiSettings.value.hasKey) { notify('请先在设置里配置 AI 增强的 API Key'); return; }
    await startAiTag();
    return;
  }
  await doTag(wizardScope.value);
}

// ---- 分类：提交后台 job，切到进度视图并轮询（完成后停留展示报告）----
async function doTag(scope = 'new') {
  if (tagging.value) return;
  tagging.value = true;
  try {
    const r = await api.tag(200, scope);
    jobId.value = r.jobId;
    jobReport.value = null;
    view.value = 'pending';
    jobProgress.value = { status: r.status, total: 0, done: 0, error: null, stats: null };
    pollJob(r.jobId);
  } catch (e) {
    notify(humanizeError(e));
    tagging.value = false;
  }
}

// AI 增强（云端）：默认只送「模型没把握」的照片；也可指定 ids（批量栏入口）
async function startAiTag(payload = {}) {
  if (tagging.value) return;
  tagging.value = true;
  try {
    const body = payload.ids ? { ids: payload.ids, scope: 'ids' } : { scope: 'review', limit: 100 };
    const r = await api.tagVlm(body);
    jobId.value = r.jobId;
    jobReport.value = null;
    view.value = 'pending';
    jobProgress.value = { status: r.status, total: 0, done: 0, error: null, stats: null };
    pollJob(r.jobId, 'ai');
  } catch (e) {
    notify('启动 AI 增强失败：' + humanizeError(e));
    tagging.value = false;
  }
}

// ---- 批量栏：对选中的图片重新分类（⚡本地 / 🧠AI）----
const batchClassifying = ref(false);
async function batchReclassify() {
  const ids = [...selectedIds.value];
  if (!ids.length || batchClassifying.value) return;
  batchClassifying.value = true;
  let done = 0;
  let tagged = 0;
  try {
    for (const id of ids) {
      try {
        const r = await api.reclassify(id);
        tagged += r.tagged || 0;
      } catch { /* 单张失败继续 */ }
      done++;
      if (done % 5 === 0) notify(`⚡ 本地重新分类中 ${done}/${ids.length}…`);
    }
    notify(`⚡ 重新分类完成：${done} 张，命中 ${tagged} 个标签`);
    await Promise.all([loadPhotos(true), loadStats(), loadVocab()]);
  } finally { batchClassifying.value = false; }
}
async function batchAiClassify() {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  if (!aiSettings.value.hasKey) {
    notify('🧠 AI 分类需要先配置 API Key：已带你到 设置 → AI 增强');
    navTo('settings');
    return;
  }
  clearSelect();
  await startAiTag({ ids });
}

function pollJob(id, kind = 'local') {
  clearInterval(jobTimer);
  jobTimer = setInterval(async () => {
    try {
      const j = await api.job(id);
      jobProgress.value = { status: j.status, total: j.total, done: j.done, error: j.error, stats: j.stats || null };
      if (j.status === 'done' || j.status === 'done_with_errors' || j.status === 'error') {
        clearInterval(jobTimer);
        tagging.value = false;
        jobId.value = null;
        // 完成后停在进度视图展示「分类报告」，由用户选择去向
        if (j.status === 'error') {
          jobReport.value = { kind, ok: false, error: j.error || '未知错误（可能首次需下载模型）' };
          notify('分类失败：' + humanizeError({ message: j.error || '未知错误' }));
        } else {
          const s = j.stats;
          const msg = s
            ? `分类完成：处理 ${s.processed} 张，标签 ${s.tagged}，待确认 ${s.review}`
            : `打标完成，处理 ${j.total} 张`;
          notify(msg);
          jobReport.value = { kind, ok: true, stats: s || { processed: j.total, tagged: null, review: null } };
        }
        await Promise.all([loadStats(), loadVocab()]);
      }
    } catch (e) {
      clearInterval(jobTimer);
      tagging.value = false;
      view.value = 'home';
      notify('分类进度查询失败：' + e.message);
    }
  }, 800);
}

function finishReport() { jobReport.value = null; view.value = 'home'; loadPhotos(true); }

// ---- 待确认审阅流 ----
async function goReview() {
  view.value = 'review';
  reviewLoading.value = true;
  try {
    const r = await api.photos({ smart: 'review', limit: 500 });
    reviewItems.value = r.items;
    reviewIdx.value = r.items.length ? 0 : -1;
  } catch (e) { notify('加载待确认失败：' + e.message); }
  finally { reviewLoading.value = false; }
  loadStats();
}

// 审阅判定：keep 升级为人工确认（保留模型置信度），remove 驳回并记反馈
async function reviewSubmit(keep, remove) {
  const item = reviewItems.value[reviewIdx.value];
  if (!item) return;
  try {
    await api.confirm(item.id, keep, remove);
    reviewItems.value.splice(reviewIdx.value, 1);
    if (reviewIdx.value >= reviewItems.value.length) reviewIdx.value = reviewItems.value.length - 1;
    await loadStats();
    if (remove.length) notify(`已移除 ${remove.length} 个错误标签，模型会记住`);
  } catch (e) { notify('提交失败：' + e.message); }
}

async function reviewSkip() {
  if (reviewIdx.value < reviewItems.value.length - 1) reviewIdx.value++;
  else notify('已经是最后一张了');
}

// ---- 词表组开关 ----
async function toggleGroup(g) {
  try {
    const r = await api.setGroup(g.name, !g.disabled);
    const local = vocab.value.find((x) => x.name === g.name);
    if (local) local.disabled = r.disabled;
    notify(r.disabled ? `已关闭「${g.name}」组，模型不再自动打这类标签` : `已开启「${g.name}」组`);
  } catch (e) { notify('修改失败：' + e.message); }
}

// ---- AI 增强设置 ----
async function saveAi(patch) {
  try {
    await api.saveAiSettings(patch);
    await loadAiSettings();
    return { ok: true };
  } catch (e) {
    notify('保存失败：' + e.message);
    return { ok: false, error: e.message };
  }
}
async function runAiTest() {
  aiTesting.value = true;
  try {
    const r = await api.aiTest();
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { aiTesting.value = false; }
}

// ---- 导出当前筛选结果到用户选择的目录 ----
async function doExport() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const picked = await api.browse();
    const target = picked?.dir;
    if (!target) { notify('未选择导出目录'); return; }
    const r = await api.export(activeFilters.value, target);
    if (r.copied > 0) notify(`已导出 ${r.copied}/${r.total} 张到 ${target}`);
    else notify(`没有可导出的图片（当前筛选为空）`);
  } catch (e) { notify('导出失败：' + e.message); }
  finally { exporting.value = false; }
}

// ---- 侧栏导航 ----
function navTo(v) { view.value = v; }

function persistPrefs() { localStorage.setItem('tagger.autoTag', autoTagAfterImport.value ? '1' : '0'); }

export function useLibrary() {
  return {
    // 状态
    info, vocab, sourceTags, countMap, stats,
    view, selectedTags, tagFilter, searchQuery, searchOpen, op, smart,
    dateFrom, dateTo, datePreset,
    photos, total, loading, limit,
    selected, selectedIndex, reclassifying, aiReclassifying,
    importing, dragging,
    selectedIds, tagging, exporting, jobId, jobProgress, jobReport,
    wizardOpen, wizardScope, wizardMode,
    reviewItems, reviewIdx, reviewLoading,
    aiSettings, aiTesting,
    toast, confirmOpen, confirmMsg,
    autoTagAfterImport,
    // 计算属性
    tagGroups, activeFilters, suggestionTags,
    // 动作
    notify, askConfirm, confirmYes,
    loadInfo, loadVocab, loadStats, loadPhotos, loadAiSettings,
    onDrop, toggleSelect, clearSelect,
    runSearch, filterByTag, toggleFilter, removeFilter, clearFilters, goHome,
    onDateChange, setDatePreset, selectSmart, setOp,
    openPhoto, reclassifyCurrent, reclassifyCurrentAi, closePhoto, resetToUnclassified, step, applyTagChange,
    onDeletePhoto, rejectPhotoTags,
    doImportFolder, doImportFiles,
    openWizard, startWizard, doTag, startAiTag, finishReport,
    batchReclassify, batchAiClassify, batchClassifying,
    goReview, reviewSubmit, reviewSkip,
    toggleGroup, saveAi, runAiTest,
    doExport, navTo, persistPrefs,
  };
}
