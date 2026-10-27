'use strict';

/* ==========================================================================
 * AI 教程弹窗：AI 写辩词 / AI 生成 PPT
 *
 * - 教程文本硬编码在下面的常量里
 * - 卡片可展开，正文是普通 DOM 文本（可选中复制），另有「复制教程」按钮
 * - 「去网页版」用 @tauri-apps/plugin-opener 的 openUrl
 * - 弹窗本身用 transform + opacity 过渡
 * ========================================================================== */

import { openUrl } from './vendor/opener.js';

const WRITER_CARDS = [
  {
    id: 'doubao',
    name: '豆包',
    url: 'https://www.doubao.com/',
    tutorial: `打开豆包网页版，输入：
你是一名高中辩论队一辩选手，代表正方参与「辩题」。我方坚持认为「立场」。
严格按以下结构输出：①开头（称呼+问好+观点，≤60字）→ ②主体（分两点，每点以‘第一：’‘第二：’起头，每点≤120字，每条理由附一个现实案例）→ ③结尾（仅一句，‘综上所述，我方坚持认为……’，≤35字）。
禁用：我觉得、大家想一想、emoji、省略号、未注明出处的数据。若输出出现‘一方面…另一方面’或‘可能’‘或许’，重新生成，只保留单边立场。`,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    tutorial: `打开 DeepSeek 网页版，输入：
你是反方辩手，辩题：「辩题」。你的立场：反对。
输出一份质询预判清单。每个预判点格式为‘对方可能主张 → 该主张的隐含前提 → 我的反驳（必须引用一条可验证的数据、判例或政策原文，注明来源）’。
列出至少 4 个预判点。不要写开场白，直接输出清单。`,
  },
  {
    id: 'qwen',
    name: '通义千问',
    url: 'https://tongyi.aliyun.com/qianwen/',
    tutorial: `打开千问网页版，输入：
请按以下骨架生成一篇完整的反方一辩稿：
〖标题〗
〖引言〗提出立场 + 一句话背景
〖论点一〗主张 + 理由 + 案例
〖论点二〗主张 + 理由 + 案例
〖结论〗总结并回扣价值
辩题：「辩题」。立场：反方。每个论点理由不少于 80 字，案例需具体到机构/时间/数据。`,
  },
];

const PPT_CARDS = [
  {
    id: 'gamma',
    name: 'Gamma',
    url: 'https://gamma.app/',
    tagline: '一句话生成整套幻灯片，速度最快。',
    tutorial:
      '打开 gamma.app → 登录（免费账号有少量 credits）→ Create presentation → 输入中文需求（主题、页数、结构、风格）→ 生成后修改 → Export 为 PPTX 或 PDF。',
    note: '免费额度有限，导出可能带品牌标识。适合快速出第一版。',
  },
  {
    id: 'quark',
    name: '夸克 PPT',
    url: 'https://ai.quark.cn/',
    tagline: '目前真免费，出稿快，适合快速成片。',
    tutorial:
      '打开夸克 AI PPT 入口 → 输入主题或粘贴大纲 → 选择页数/风格 → 生成完整 PPT → 在线编辑或导出。',
    note: '免费可用，模板数量有限。',
  },
  {
    id: 'doubao',
    name: '豆包',
    url: 'https://www.doubao.com/',
    tagline: '中文文案质量高，适合先生成大纲和文字内容。',
    tutorial:
      "打开豆包网页版 → 输入主题和受众，让豆包生成大纲 → 确认大纲后继续指令‘根据以上大纲生成每页的标题、正文和演讲备注’→ 复制内容到 PowerPoint 或 WPS 套模板。",
    note: '豆包主要生成文字内容，不直接产出精美模板。',
  },
];

function createCard(card, notify) {
  const article = document.createElement('article');
  article.className = 'ai-card';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'ai-card-head';
  head.setAttribute('aria-expanded', 'false');

  const title = document.createElement('span');
  title.className = 'ai-card-title';
  const name = document.createElement('span');
  name.textContent = card.name;
  title.append(name);
  if (card.tagline) {
    const tag = document.createElement('span');
    tag.className = 'ai-card-tag';
    tag.textContent = card.tagline;
    title.append(tag);
  }

  const arrow = document.createElement('span');
  arrow.className = 'ai-card-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '▾';
  head.append(title, arrow);

  const body = document.createElement('div');
  body.className = 'ai-card-body';
  const inner = document.createElement('div');
  inner.className = 'ai-card-inner';

  const text = document.createElement('div');
  text.className = 'ai-card-text';
  text.textContent = card.tutorial;
  text.setAttribute('role', 'textbox');
  text.setAttribute('aria-readonly', 'true');
  text.setAttribute('tabindex', '0'); // 让键盘能聚焦后 Ctrl+A 选中
  inner.append(text);

  if (card.note) {
    const note = document.createElement('p');
    note.className = 'ai-card-note';
    note.textContent = card.note;
    inner.append(note);
  }

  body.append(inner);

  const foot = document.createElement('div');
  foot.className = 'ai-card-foot';

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'btn btn-primary';
  go.textContent = '去网页版';
  go.addEventListener('click', () => {
    void openUrl(card.url).catch(() => {
      notify('打开浏览器失败，请手动访问 ' + card.url);
    });
  });

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-ghost';
  copy.textContent = '复制教程';
  copy.addEventListener('click', () => {
    const done = () => notify('教程已复制');
    const failed = () => notify('复制失败，可点正文后 Ctrl+A 手动复制');
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      failed();
      return;
    }
    navigator.clipboard.writeText(card.tutorial).then(done, failed);
  });

  foot.append(go, copy);

  head.addEventListener('click', () => {
    const open = !article.classList.contains('is-open');
    article.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', String(open));
  });

  article.append(head, body, foot);
  return article;
}

function createModal({ root, host, cards, closeButton, backdrop, notify }) {
  let closeTimer = 0;

  cards.forEach((card, index) => {
    const el = createCard(card, notify);
    if (index === 0) {
      // 默认展开第一张，其余收起
      el.classList.add('is-open');
      el.querySelector('.ai-card-head').setAttribute('aria-expanded', 'true');
    }
    host.append(el);
  });

  function open() {
    clearTimeout(closeTimer);
    root.hidden = false;
    void root.offsetWidth; // 先上屏再触发过渡
    root.classList.add('is-open');
    document.body.classList.add('modal-open');
  }

  function close() {
    if (root.hidden) return;
    root.classList.remove('is-open');
    document.body.classList.remove('modal-open');
    closeTimer = setTimeout(() => {
      root.hidden = true;
    }, 240);
  }

  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.hidden) close();
  });

  return { open, close };
}

export function initGuides({ notify }) {
  const writer = createModal({
    root: document.getElementById('writerModal'),
    host: document.getElementById('writerCards'),
    cards: WRITER_CARDS,
    closeButton: document.getElementById('writerClose'),
    backdrop: document.getElementById('writerBackdrop'),
    notify,
  });

  const ppt = createModal({
    root: document.getElementById('pptAiModal'),
    host: document.getElementById('pptAiCards'),
    cards: PPT_CARDS,
    closeButton: document.getElementById('pptAiClose'),
    backdrop: document.getElementById('pptAiBackdrop'),
    notify,
  });

  return {
    openWriter: writer.open,
    openPpt: ppt.open,
  };
}
