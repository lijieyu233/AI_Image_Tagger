<script setup>
import { ref, computed } from 'vue';
import { api } from '../api.js';
import { useLibrary } from '../composables/useLibrary.js';

const { vocab, sourceTags, countMap, notify, askConfirm, loadVocab, toggleGroup, goHome, filterByTag } = useLibrary();

const query = ref('');
const match = (n) => !query.value.trim() || n.includes(query.value.trim());

// 每组的"这是什么"说明（不懂得原理也能看懂这页）
const KIND_LABEL = { auto: '模型自动打', system: '导入规则打', manual: '手动添加' };
const GROUP_DESC = {
  '来源/形式': '导入时按规则判断，不耗模型：文件名含 Screenshot → 截图，宽高比悬殊 → 全景，等',
  '人': '本地模型看内容自动打的标签（人物相关）',
  '场景': '本地模型看内容自动打的标签（室内外、地点）',
  '活动': '本地模型看内容自动打的标签（在做什么）',
  '物品': '本地模型看内容自动打的标签（东西和动植物）',
  '文档': '证件 / 发票类。默认不送云端 AI 增强（隐私红线），可在设置里放开',
  '用途': '你自己加标签时的默认分组，适合放「可发」「待删」这类整理词；模型不会自动打',
};

const cards = computed(() => (vocab.value || []).map((g) => ({
  ...g,
  shown: g.tags.filter(match),
})));
const sysCount = computed(() => sourceTags.value.length);

const showAddTag = ref(false);
const newTagName = ref('');
const newTagGroup = ref('用途');
const newTagKind = ref('manual');
function openAdd(group) { newTagGroup.value = group || '用途'; showAddTag.value = true; }
async function addTagConfirm() {
  const name = newTagName.value.trim();
  if (!name) { showAddTag.value = false; return; }
  try { await api.addTag(name, newTagGroup.value, newTagKind.value); notify(`已添加标签「${name}」`); await loadVocab(); }
  catch (e) { notify('添加失败：' + e.message); }
  showAddTag.value = false; newTagName.value = '';
}
async function removeTag(name) {
  askConfirm(`确定删除标签「${name}」吗？已打在该标签上的关联会被移除（重新分类可恢复自动标签）。`, async () => {
    try { await api.deleteTag(name); notify(`已删除标签「${name}」`); await loadVocab(); }
    catch (e) { notify('删除失败：' + e.message); }
  });
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h2>标签管理</h2>
      <span class="muted small">标签 = 分类模型能「想到」的全部词。悬停标签出现 🗑 可删除；组开关控制模型是否自动打这组。</span>
      <span class="spacer" />
      <input v-model="query" placeholder="🔍 搜标签…" class="q" />
      <button class="primary" @click="openAdd()">＋ 新增词条</button>
      <button @click="goHome">返回图库</button>
    </div>

    <div class="guide">
      这一页是<b>分类模型的「词表」</b>：模型打标签时只能从下面的清单里选词，图上看到的每个标签都来自这里。
      标签后的数字 = 已打了多少张；悬停标签出现 🗑 可删除；「自动打标」开关 = 要不要让模型自动打这一组。
      想让模型认识新东西，就「＋ 新增词条」加词。
    </div>

    <div class="cards">
      <div v-for="g in cards" :key="g.name" class="card" :class="{ off: g.disabled }">
        <div class="card-head">
          <b>{{ g.name }}</b>
          <span class="kind" :class="g.kind">{{ KIND_LABEL[g.kind] || g.kind }}</span>
          <span class="spacer" />
          <label v-if="g.kind === 'auto'" class="sw" :title="g.disabled ? '已停用：模型不会自动打这组' : '开启中：模型会自动打这组'">
            <input type="checkbox" :checked="!g.disabled" @change="toggleGroup(g)" /> 自动打标
          </label>
          <button class="sm" :title="`往「${g.name}」组加标签`" @click="openAdd(g.name)">＋</button>
        </div>
        <div class="desc">{{ GROUP_DESC[g.name] || '这一组的标签' }}</div>
        <div class="chips">
          <span v-for="t in g.shown" :key="t.name" class="chip click" :class="{ auto: g.kind === 'auto' }"
            :title="`点击筛选有「${t.name}」的图片`" @click="filterByTag(t.name)">
            {{ t.name }}<span v-if="(countMap[t.name] ?? 0) > 0" class="c">{{ countMap[t.name] }}</span>
            <i class="del" title="删除这个标签" @click.stop="removeTag(t.name)">🗑</i>
          </span>
          <span v-if="!g.shown.length" class="none">无匹配标签</span>
        </div>
      </div>

      <div class="card" v-if="sysCount">
        <div class="card-head"><b>来源目录</b><span class="kind system">导入规则打</span><span class="spacer" /></div>
        <div class="desc">导入时按文件夹名自动打的标签，标记图片来自哪个目录（不算模型打标）</div>
        <div class="chips">
          <span v-for="t in sourceTags" :key="t.name" class="chip sys">{{ t.name }}<span class="c">{{ t.c }}</span></span>
        </div>
      </div>
    </div>

    <div v-if="showAddTag" class="mask" @click.self="showAddTag = false">
      <div class="dialog">
        <div class="dlg-head">新增词条</div>
        <div class="dlg-body">
          <p class="muted">标签名称：</p>
          <input v-model="newTagName" placeholder="如：宠物" @keyup.enter="addTagConfirm" />
          <p class="muted small">分组与类型（自动标签的分组需与模型提示词匹配）：</p>
          <div class="dir-row">
            <input v-model="newTagGroup" placeholder="分组" />
            <select v-model="newTagKind">
              <option value="manual">manual</option>
              <option value="auto">auto</option>
              <option value="system">system</option>
            </select>
          </div>
        </div>
        <div class="dlg-foot">
          <button @click="showAddTag = false">取消</button>
          <button class="primary" @click="addTagConfirm">添加</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { flex: 1; overflow: auto; padding: 24px 28px; }
.page-head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.page-head h2 { font-size: 18px; color: var(--text); }
.page-head .spacer { flex: 1; }
.q { width: 160px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
.guide { background: var(--accent-soft); border: 1px solid var(--accent-border); border-radius: 12px; padding: 12px 16px; font-size: 13px; color: var(--text-2); margin-bottom: 16px; max-width: 960px; }
.guide b { color: var(--text); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; }
.card.off { opacity: .55; }
.card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.card-head b { font-size: 14px; }
.desc { font-size: 11.5px; color: var(--muted); margin-bottom: 10px; line-height: 1.5; }
.kind { font-size: 10px; padding: 2px 7px; border-radius: 5px; background: var(--surface-2); color: var(--muted); }
.kind.auto { background: var(--accent-soft); color: var(--accent); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 5px; }
.chip.click { cursor: pointer; }
.chip.click:hover { outline: 1px solid var(--accent-border); }
.chip .c { color: var(--muted-2); font-size: 10px; }
.chip .del { cursor: pointer; font-size: 10px; opacity: 0; transition: opacity .12s; font-style: normal; }
.chip:hover .del { opacity: .75; }
.chip .del:hover { opacity: 1; }
.none { color: var(--muted-2); font-size: 12px; }
.spacer { flex: 1; }
.sw { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); cursor: pointer; }
button.sm { padding: 3px 9px; font-size: 12px; }

.mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .6); display: flex; align-items: center; justify-content: center; z-index: 100; }
.dialog { width: 440px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; box-shadow: var(--shadow-lg); }
.dlg-head { padding: 14px 16px; font-weight: 600; font-size: 14px; border-bottom: 1px solid var(--border-2); }
.dlg-body { padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.dir-row { display: flex; gap: 8px; }
.dir-row input { flex: 1; }
.dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; background: var(--surface-2); border-top: 1px solid var(--border-2); }
.dlg-foot button { width: auto; }
</style>
