'use strict';

/* ==========================================================================
 * 辞之漏辩论计时器 —— 主界面逻辑
 *
 * 结构：
 *   state.format.phases[]   按顺序排列的环节
 *   applyPhase(index)       装载第 index 个环节
 *   nextPhase()             进入下一环节
 *   loadFormat(format)      整套替换赛制（导入 JSON 后调用）
 *   window.__debate         调试 / 扩展钩子
 *
 * 依赖：@tauri-apps/plugin-dialog、plugin-fs、plugin-store
 * 因为没有打包器，插件的 ESM 代码以 src/vendor 形式随页面分发，
 * 由 index.html 的 importmap 把 @tauri-apps/api/* 映射到本地副本。
 * ========================================================================== */

import { open } from './vendor/dialog.js';
import { readTextFile } from './vendor/fs.js';
import { load as loadPluginStore } from './vendor/store.js';
import { initWorkshop } from './workshop.js';
import { initGuides } from './guides.js';
import { initPpt } from './ppt.js';
import { initScreens } from './screens.js';

const SIDES = ['pro', 'con'];
const SIDE_LABEL = { pro: '正方', con: '反方' };

/** 默认赛制：一个环节，双方各 3 分钟。 */
const DEFAULT_FORMAT = {
  id: 'free-debate',
  name: '自由辩论',
  phases: [{ id: 'free', name: '自由辩论', seconds: { pro: 180, con: 180 } }],
};

/**
 * 内置赛制预设：从「选择赛制」下拉直接加载，无需导入 JSON。
 * 结构与自定义 JSON 的 phases 数组一致，seconds 支持 number 或 { pro, con }；
 * 想调整环节，直接改这里即可。
 */
const FORMAT_PRESETS = {
  standard: {
    id: 'standard',
    name: '华辩标准赛制',
    phases: [
      { id: 'standard-1', name: '正方一辩立论', seconds: 180 },
      { id: 'standard-2', name: '反方一辩立论', seconds: 180 },
      { id: 'standard-3', name: '正方二辩驳立论', seconds: 150 },
      { id: 'standard-4', name: '反方二辩驳立论', seconds: 150 },
      { id: 'standard-5', name: '正方三辩质询', seconds: 120 },
      { id: 'standard-6', name: '反方三辩质询', seconds: 120 },
      { id: 'standard-7', name: '正方三辩质询小结', seconds: 90 },
      { id: 'standard-8', name: '反方三辩质询小结', seconds: 90 },
      { id: 'standard-9', name: '自由辩论', seconds: { pro: 240, con: 240 } },
      { id: 'standard-10', name: '反方四辩总结陈词', seconds: 180 },
      { id: 'standard-11', name: '正方四辩总结陈词', seconds: 180 },
    ],
  },
  bp: {
    id: 'bp',
    name: '英国议会制 (BP)',
    phases: [
      { id: 'bp-1', name: '首相发言', seconds: 420 },
      { id: 'bp-2', name: '反对党领袖发言', seconds: 420 },
      { id: 'bp-3', name: '副首相发言', seconds: 420 },
      { id: 'bp-4', name: '反对党副领袖发言', seconds: 420 },
      { id: 'bp-5', name: '政府成员发言', seconds: 420 },
      { id: 'bp-6', name: '反对党成员发言', seconds: 420 },
      { id: 'bp-7', name: '政府党鞭总结', seconds: 240 },
      { id: 'bp-8', name: '反对党党鞭总结', seconds: 240 },
    ],
  },
};

/** 提示音触发点（秒） */
const CUE_THRESHOLDS = [30, 5, 0];
/** 数字滚动动画时长，需与 styles.css 中 .glyph 的 transition 保持一致 */
const ROLL_MS = 150;

/** 持久化 */
const STORE_FILE = 'debate-store.json';
const PERSIST_DEBOUNCE_MS = 350;
const FORMAT_ERROR_TEXT = 'JSON 格式不正确，请检查 name 和 seconds 字段';

const state = {
  format: DEFAULT_FORMAT,
  phaseIndex: 0,
  running: false,
  clockStart: 0,
  ticker: null,
  topic: '',
  /** 导入赛制的原始 JSON 文本，用于持久化恢复；默认赛制为 null */
  formatSource: null,
  /** 辩词素材片段（按空行切分），供文案工坊使用 */
  scriptSegments: [],
  /** 文案工坊的接口配置；apiKey 只存 plugin-store，不进 localStorage */
  llmConfig: { baseUrl: '', apiKey: '', model: '' },
  /** PPT 背景显示配置：遮罩浓度（0-60）与文字描边颜色 */
  bgConfig: { dim: 15, stroke: 'black' },
  sides: {
    pro: createSide('pro'),
    con: createSide('con'),
  },
};

const dom = {};
const cells = { pro: [], con: [] };
let audioCtx = null;
let stageTimer = null;
let toastTimer = null;
let store = null;
let persistTimer = null;
let workshop = null;
let guides = null;
let ppt = null;
let screens = null;

/* ==========================================================================
 * 小工具
 * ========================================================================== */

function createSide(id) {
  return {
    id,
    team: SIDE_LABEL[id],
    totalMs: 0,
    remainingMs: 0,
    shownMs: 0,
    startRemaining: 0,
    finished: false,
  };
}

/** 把毫秒格式化成 MM:SS.d（向上取整到 0.1 秒） */
function formatTime(ms) {
  const tenths = Math.max(0, Math.ceil(ms / 100));
  const tenth = tenths % 10;
  const totalSeconds = Math.floor(tenths / 10);
  const seconds = totalSeconds % 60;
  const minutes = Math.min(99, Math.floor(totalSeconds / 60));
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenth}`;
}

/** 环节预设秒数 → 分钟标签（用于环节芯片） */
function clockLabel(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function presetLabel(phase) {
  const seconds = phase.seconds;
  if (typeof seconds === 'number') return clockLabel(seconds);
  if (seconds.pro === seconds.con) return clockLabel(seconds.pro);
  return `正${clockLabel(seconds.pro)}·反${clockLabel(seconds.con)}`;
}

/** 环节时长：支持 number 或 { pro, con } / { default } */
function phaseSeconds(phase, side) {
  const spec = phase ? phase.seconds : undefined;
  if (typeof spec === 'number') return spec;
  if (spec && typeof spec === 'object') {
    if (typeof spec[side] === 'number') return spec[side];
    if (typeof spec.default === 'number') return spec.default;
  }
  return 0;
}

/* ==========================================================================
 * 赛制 JSON 解析与校验
 * ========================================================================== */

class FormatError extends Error {
  constructor() {
    super(FORMAT_ERROR_TEXT);
    this.name = 'FormatError';
  }
}

/** 秒数规范化：返回 number / { pro, con }，非法返回 null */
function normalizeSeconds(raw) {
  if (typeof raw === 'number') {
    return raw > 0 ? raw : null;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const pro = typeof raw.pro === 'number' && raw.pro > 0 ? raw.pro : null;
    const con = typeof raw.con === 'number' && raw.con > 0 ? raw.con : null;
    if (pro === null && con === null) return null;
    return { pro: pro ?? con, con: con ?? pro };
  }
  return null;
}

/**
 * 解析赛制文件：[{ "name": "立论", "seconds": 180 }, ...]
 * 也兼容 seconds 写成 { "pro": 240, "con": 180 } 的双方不同时长。
 * 任何格式问题都抛 FormatError。
 */
function parseFormatJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FormatError();
  }

  if (!Array.isArray(data) || data.length === 0) throw new FormatError();

  return data.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new FormatError();

    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) throw new FormatError();

    const seconds = normalizeSeconds(item.seconds);
    if (!seconds) throw new FormatError();

    return { id: `imported-${index}`, name, seconds };
  });
}

/* ==========================================================================
 * 辩词素材切分
 * ========================================================================== */

/** 按空行切分段落；连续空行、前后空白都归一化 */
function splitScript(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n[\s]*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/* ==========================================================================
 * 倒计时数字：逐字符纵向滚动（AnimatedContent 风格）
 * ========================================================================== */

const DIGIT_LAYOUT = ['digit', 'digit', 'sep:', 'digit', 'digit', 'sep.', 'digit'];

function buildTimeDisplay(host) {
  host.textContent = '';
  return DIGIT_LAYOUT.map((spec) => {
    const cell = document.createElement('span');
    host.append(cell);

    if (spec.startsWith('sep')) {
      cell.className = 'digit sep';
      cell.textContent = spec.slice(3);
      return { cell, separator: true };
    }

    cell.className = 'digit';
    const cur = document.createElement('span');
    cur.className = 'glyph cur';
    cur.textContent = '0';
    const next = document.createElement('span');
    next.className = 'glyph next';
    next.textContent = '0';
    next.setAttribute('aria-hidden', 'true');
    cell.append(cur, next);
    return { cell, cur, next, value: '0', timer: 0, separator: false };
  });
}

function commitChar(cell) {
  cell.cell.classList.add('no-anim');
  cell.cur.textContent = cell.value;
  cell.cell.classList.remove('rolling');
  void cell.cell.offsetWidth; // 强制回流，让 no-anim 生效后再恢复过渡
  cell.cell.classList.remove('no-anim');
  if (cell.timer) {
    clearTimeout(cell.timer);
    cell.timer = 0;
  }
}

function setChar(cell, ch) {
  if (cell.value === ch) return;
  if (cell.timer) commitChar(cell); // 上一次还没滚完：先落定，再滚新值
  cell.value = ch;
  cell.next.textContent = ch;
  cell.cell.classList.add('rolling');
  cell.timer = setTimeout(() => commitChar(cell), ROLL_MS);
}

function renderTime(sideId, ms) {
  const text = formatTime(ms);
  const list = cells[sideId];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].separator) continue;
    setChar(list[i], text[i]);
  }
}

/* ==========================================================================
 * 渲染
 * ========================================================================== */

function paintPhaseList() {
  const phases = state.format.phases;
  const frag = document.createDocumentFragment();

  phases.forEach((phase, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `phase-chip${index === state.phaseIndex ? ' is-current' : ''}`;
    chip.dataset.index = String(index);
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(index === state.phaseIndex));

    const num = document.createElement('span');
    num.className = 'phase-num';
    num.textContent = String(index + 1);

    const name = document.createElement('span');
    name.className = 'phase-name';
    name.textContent = phase.name;

    const time = document.createElement('span');
    time.className = 'phase-time';
    time.textContent = presetLabel(phase);

    chip.append(num, name, time);
    chip.addEventListener('click', () => switchPhase(index));
    frag.append(chip);
  });

  dom.phaseList.textContent = '';
  dom.phaseList.append(frag);
}

function paintTeam(sideId) {
  const side = state.sides[sideId];
  const name = side.team.trim() || SIDE_LABEL[sideId];
  if (dom.teamName[sideId].textContent !== name) {
    dom.teamName[sideId].textContent = name;
  }
}

function paintTeams(syncInputs = false) {
  for (const sideId of SIDES) {
    paintTeam(sideId);
    if (syncInputs) dom.teamInput[sideId].value = state.sides[sideId].team;
  }
}

function paintTopicPreview() {
  const text = state.topic.trim();
  dom.topicPreview.textContent = text || '未设置辩题';
  dom.topicPreview.classList.toggle('is-empty', !text);
}

function paintScriptStatus() {
  const count = state.scriptSegments.length;
  dom.scriptStatus.textContent = count > 0 ? `素材：已导入 ${count} 个片段` : '素材：未导入';
  dom.scriptStatus.classList.toggle('is-ready', count > 0);
}

function paintSide(sideId, ms) {
  renderTime(sideId, ms);
  const side = state.sides[sideId];
  const ratio = side.totalMs > 0 ? Math.max(0, Math.min(1, ms / side.totalMs)) : 0;
  dom.progress[sideId].style.transform = `scaleX(${ratio.toFixed(4)})`;
}

function paintUrgency() {
  for (const sideId of SIDES) {
    const ms = state.sides[sideId].remainingMs;
    const panel = dom.panel[sideId];
    panel.classList.toggle('is-warn', ms > 5000 && ms <= 30000);
    panel.classList.toggle('is-danger', ms > 0 && ms <= 5000);
    panel.classList.toggle('is-finished', ms <= 0);
  }
  paintStatuses();
}

function sideStatus(sideId) {
  const side = state.sides[sideId];
  if (side.remainingMs <= 0) return '时间到';
  if (state.running) return '计时中';
  if (side.remainingMs < side.totalMs) return '已暂停';
  return '就绪';
}

function paintStatuses() {
  for (const sideId of SIDES) {
    const text = sideStatus(sideId);
    if (dom.status[sideId].textContent !== text) {
      dom.status[sideId].textContent = text;
    }
  }
}

function paintControls() {
  const btn = dom.btnToggle;
  const allDone = SIDES.every((sideId) => state.sides[sideId].remainingMs <= 0);
  const untouched = SIDES.every(
    (sideId) => state.sides[sideId].remainingMs >= state.sides[sideId].totalMs,
  );

  btn.disabled = allDone && !state.running;
  btn.dataset.state = state.running ? 'running' : allDone ? 'done' : untouched ? 'idle' : 'paused';
  btn.textContent = state.running ? '暂停' : allDone ? '已结束' : untouched ? '开始' : '继续';
  btn.setAttribute('aria-pressed', String(state.running));
}

function playStageTransition() {
  dom.stage.classList.remove('phase-enter');
  void dom.stage.offsetWidth;
  dom.stage.classList.add('phase-enter');
  clearTimeout(stageTimer);
  stageTimer = setTimeout(() => dom.stage.classList.remove('phase-enter'), 380);
}

function notify(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 2600);
}

/* ==========================================================================
 * 环节装载 / 切换
 * ========================================================================== */

function applyPhase(index, { animate = false } = {}) {
  const phase = state.format.phases[index];
  if (!phase) return;

  state.phaseIndex = index;
  for (const sideId of SIDES) {
    const side = state.sides[sideId];
    const totalMs = Math.max(0, Math.round(phaseSeconds(phase, sideId) * 1000));
    side.totalMs = totalMs;
    side.remainingMs = totalMs;
    side.shownMs = totalMs;
    side.startRemaining = totalMs;
    side.finished = totalMs <= 0;
  }

  paintPhaseList();
  for (const sideId of SIDES) paintSide(sideId, state.sides[sideId].remainingMs);
  paintUrgency();
  paintControls();
  if (animate) playStageTransition();
}

function switchPhase(index) {
  const phases = state.format.phases;
  if (index < 0 || index >= phases.length || index === state.phaseIndex) return;
  stopTicker();
  state.running = false;
  applyPhase(index, { animate: true });
  schedulePersist();
}

function nextPhase() {
  const next = state.phaseIndex + 1;
  if (next >= state.format.phases.length) {
    notify('已经是最后一个环节');
    return false;
  }
  switchPhase(next);
  return true;
}

/** 整套替换赛制（导入 JSON 后调用） */
function loadFormat(format, { source = null, persist = true } = {}) {
  if (!format || !Array.isArray(format.phases) || format.phases.length === 0) {
    throw new FormatError();
  }
  stopTicker();
  state.running = false;
  state.format = format;
  state.formatSource = source;
  applyPhase(0, { animate: true });
  if (persist) schedulePersist();
}

/* ==========================================================================
 * 计时控制
 * ========================================================================== */

function stopTicker() {
  if (state.ticker) {
    clearInterval(state.ticker);
    state.ticker = null;
  }
}

/** 结算到“此刻”，返回仍在计时的栏数 */
function tickOnce() {
  const elapsed = performance.now() - state.clockStart;
  let alive = 0;

  for (const sideId of SIDES) {
    const side = state.sides[sideId];
    if (side.finished) continue;

    const next = Math.max(0, side.startRemaining - elapsed);
    fireCues(side.shownMs, next);
    side.shownMs = next;
    side.remainingMs = next;
    paintSide(sideId, next);

    if (next <= 0) {
      side.finished = true;
    } else {
      alive += 1;
    }
  }

  paintUrgency();
  return alive;
}

function tick() {
  const alive = tickOnce();
  if (alive === 0) {
    stopTicker();
    state.running = false;
    paintControls();
  }
}

function startTimer() {
  if (state.running) return;
  const anyLeft = SIDES.some((sideId) => state.sides[sideId].remainingMs > 0);
  if (!anyLeft) {
    notify('本环节已结束，请先重置');
    return;
  }

  ensureAudio();

  for (const sideId of SIDES) {
    const side = state.sides[sideId];
    side.startRemaining = side.remainingMs;
    side.shownMs = side.remainingMs;
  }

  state.running = true;
  state.clockStart = performance.now();
  state.ticker = setInterval(tick, 100);
  tickOnce();
  paintControls();
  paintStatuses();
}

function pauseTimer() {
  if (!state.running) return;
  state.running = false;
  stopTicker();
  tickOnce(); // 把剩余时间结算到暂停的那一刻
  paintControls();
  paintStatuses();
}

function toggleTimer() {
  if (state.running) pauseTimer();
  else startTimer();
}

function resetTimer() {
  stopTicker();
  state.running = false;
  applyPhase(state.phaseIndex, { animate: true });
}

function swapSides() {
  const wasRunning = state.running;
  if (wasRunning) pauseTimer();

  const a = state.sides.pro;
  const b = state.sides.con;

  [a.team, b.team] = [b.team, a.team];
  [a.remainingMs, b.remainingMs] = [b.remainingMs, a.remainingMs];
  [a.shownMs, b.shownMs] = [b.shownMs, a.shownMs];
  [a.finished, b.finished] = [b.finished, a.finished];
  a.startRemaining = a.remainingMs;
  b.startRemaining = b.remainingMs;

  paintTeams(true);
  for (const sideId of SIDES) paintSide(sideId, state.sides[sideId].remainingMs);
  paintUrgency();
  paintControls();
  playStageTransition();

  if (wasRunning) startTimer();
  notify('已交换正反方');
  schedulePersist();
}

/* ==========================================================================
 * Web Audio 提示音（不依赖外部音频文件）
 * ========================================================================== */

function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      audioCtx = new Ctx();
    } catch {
      audioCtx = null;
      return null;
    }
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function tone({ freq, start = 0, duration = 0.12, type = 'sine', gain = 0.18, bendTo = null }) {
  const ctx = ensureAudio();
  if (!ctx) return;

  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (bendTo) osc.frequency.exponentialRampToValueAtTime(bendTo, t0 + duration);

  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  osc.connect(amp).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

const CUES = {
  30: () => {
    tone({ freq: 880, duration: 0.09 });
    tone({ freq: 880, start: 0.16, duration: 0.09 });
  },
  5: () => {
    tone({ freq: 1180, duration: 0.07 });
    tone({ freq: 1180, start: 0.14, duration: 0.07 });
    tone({ freq: 1180, start: 0.28, duration: 0.07 });
  },
  0: () => {
    tone({ freq: 560, duration: 0.65, bendTo: 190, gain: 0.22 });
  },
};

/** 只在“跨过阈值”时响一次，暂停/继续不会重复触发 */
function fireCues(prev, next) {
  for (const seconds of CUE_THRESHOLDS) {
    const limit = seconds * 1000;
    if (prev > limit && next <= limit) CUES[seconds]();
  }
}

/* ==========================================================================
 * 持久化（plugin-store）
 * ========================================================================== */

async function initStore() {
  try {
    store = await loadPluginStore(STORE_FILE, { autoSave: false });
  } catch (err) {
    store = null;
    console.warn('[store] 初始化失败，本次修改不会持久化', err);
  }
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persistState();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistState() {
  if (!store) return;
  try {
    await store.set('topic', state.topic);
    await store.set('teams', {
      pro: state.sides.pro.team,
      con: state.sides.con.team,
    });
    await store.set('formatJson', state.formatSource);
    await store.set('phaseIndex', state.phaseIndex);
    await store.set('scriptSegments', state.scriptSegments);
    await store.set('llmConfig', state.llmConfig);
    await store.set('bgConfig', state.bgConfig);
    await store.save();
  } catch (err) {
    console.warn('[store] 保存失败', err);
  }
}

async function restoreState() {
  if (!store) return;
  try {
    const [topic, teams, formatJson, phaseIndex, segments, llmConfig, bgConfig] =
      await Promise.all([
        store.get('topic'),
        store.get('teams'),
        store.get('formatJson'),
        store.get('phaseIndex'),
        store.get('scriptSegments'),
        store.get('llmConfig'),
        store.get('bgConfig'),
      ]);

    if (typeof topic === 'string') {
      state.topic = topic;
      dom.topicInput.value = topic;
      paintTopicPreview();
    }

    if (teams && typeof teams === 'object') {
      if (typeof teams.pro === 'string') state.sides.pro.team = teams.pro;
      if (typeof teams.con === 'string') state.sides.con.team = teams.con;
      paintTeams(true);
    }

    if (typeof formatJson === 'string') {
      try {
        state.format = { id: 'imported', name: '导入赛制', phases: parseFormatJson(formatJson) };
        state.formatSource = formatJson;
        applyPhase(0);
      } catch {
        // 存档里的赛制已损坏：忽略，保持默认赛制
        state.formatSource = null;
      }
    }

    if (
      typeof phaseIndex === 'number' &&
      Number.isInteger(phaseIndex) &&
      phaseIndex >= 0 &&
      phaseIndex < state.format.phases.length
    ) {
      applyPhase(phaseIndex);
    }

    if (Array.isArray(segments)) {
      state.scriptSegments = segments.filter((item) => typeof item === 'string' && item.trim());
      paintScriptStatus();
    }

    if (llmConfig && typeof llmConfig === 'object') {
      state.llmConfig = {
        baseUrl: typeof llmConfig.baseUrl === 'string' ? llmConfig.baseUrl : '',
        apiKey: typeof llmConfig.apiKey === 'string' ? llmConfig.apiKey : '',
        model: typeof llmConfig.model === 'string' ? llmConfig.model : '',
      };
    }

    if (bgConfig && typeof bgConfig === 'object') {
      state.bgConfig = {
        dim: typeof bgConfig.dim === 'number' ? bgConfig.dim : 15,
        stroke: bgConfig.stroke === 'white' ? 'white' : 'black',
      };
    }
  } catch (err) {
    console.warn('[store] 恢复失败', err);
  }
}

/* ==========================================================================
 * 文件导入（dialog + fs）
 * ========================================================================== */

/** 打开系统文件选择框；取消返回 null */
async function pickFile({ title, extensions }) {
  const picked = await open({
    title,
    multiple: false,
    directory: false,
    filters: [{ name: title, extensions }],
  });
  if (!picked) return null;
  return Array.isArray(picked) ? picked[0] : picked;
}

/** 从指定路径导入赛制（与文件选择分离，便于测试与后续拖拽复用） */
async function importFormatFromPath(path) {
  let text;
  try {
    text = await readTextFile(path);
  } catch (err) {
    console.warn('[fs] 读取赛制失败', err);
    notify('读取文件失败，请重试');
    return false;
  }

  let phases;
  try {
    phases = parseFormatJson(text);
  } catch (err) {
    notify(FORMAT_ERROR_TEXT);
    return false;
  }

  state.format = { id: 'imported', name: '导入赛制', phases };
  state.formatSource = text;
  stopTicker();
  state.running = false;
  applyPhase(0, { animate: true });
  await persistState();
  notify(`已导入赛制：${phases.length} 个环节`);
  return true;
}

async function importFormatFile() {
  let path;
  try {
    path = await pickFile({ title: '赛制 JSON', extensions: ['json'] });
  } catch (err) {
    console.warn('[dialog] 打开失败', err);
    notify('无法打开文件选择框');
    return;
  }
  if (!path) return;
  await importFormatFromPath(path);
}

/**
 * 处理「选择赛制」下拉：
 * - standard / bp → 加载内置预设
 * - custom → 打开系统文件框导入自定义 JSON
 * 加载后把下拉复位到占位项，方便下次直接选择。
 */
async function applyFormatSelection() {
  const value = dom.selectFormat.value;
  if (!value) return;

  if (value === 'custom') {
    dom.selectFormat.value = '';
    await importFormatFile();
    return;
  }

  const preset = FORMAT_PRESETS[value];
  dom.selectFormat.value = '';
  if (!preset) return;

  // 预设与自定义 JSON 共用同一条持久化通道：把环节写成 JSON 文本存进 formatJson
  loadFormat(structuredClone(preset), { source: JSON.stringify(preset.phases) });
  notify(`已加载赛制：${preset.name}（${preset.phases.length} 个环节）`);
}

/** 从指定路径导入辩词素材 */
async function importScriptFromPath(path) {
  let text;
  try {
    text = await readTextFile(path);
  } catch (err) {
    console.warn('[fs] 读取素材失败', err);
    notify('读取辩词素材失败，请重试');
    return false;
  }

  const segments = splitScript(text);
  if (segments.length === 0) {
    notify('文件里没有可用的段落');
    return false;
  }

  state.scriptSegments = segments;
  paintScriptStatus();
  await persistState();
  notify(`已导入 ${segments.length} 个片段`);
  return true;
}

async function importScriptFile() {
  let path;
  try {
    path = await pickFile({ title: '辩词素材', extensions: ['txt', 'md', 'markdown'] });
  } catch (err) {
    console.warn('[dialog] 打开失败', err);
    notify('无法打开文件选择框');
    return;
  }
  if (!path) return;
  await importScriptFromPath(path);
}

/* ==========================================================================
 * DOM 事件
 * ========================================================================== */

function cacheDom() {
  dom.topbar = document.getElementById('topbar');
  dom.topicToggle = document.getElementById('topicToggle');
  dom.topicPanel = document.getElementById('topicPanel');
  dom.topicInput = document.getElementById('topicInput');
  dom.topicPreview = document.getElementById('topicPreview');
  dom.stage = document.getElementById('stage');
  dom.phaseList = document.getElementById('phaseList');
  dom.scriptStatus = document.getElementById('scriptStatus');
  dom.toast = document.getElementById('toast');

  dom.panel = {
    pro: document.querySelector('[data-panel="pro"]'),
    con: document.querySelector('[data-panel="con"]'),
  };
  dom.time = {
    pro: document.querySelector('[data-time="pro"]'),
    con: document.querySelector('[data-time="con"]'),
  };
  dom.status = {
    pro: document.querySelector('[data-status="pro"]'),
    con: document.querySelector('[data-status="con"]'),
  };
  dom.progress = {
    pro: document.querySelector('[data-progress="pro"]'),
    con: document.querySelector('[data-progress="con"]'),
  };
  dom.teamName = {
    pro: document.querySelector('[data-team="pro"]'),
    con: document.querySelector('[data-team="con"]'),
  };
  dom.teamInput = {
    pro: document.querySelector('[data-team-input="pro"]'),
    con: document.querySelector('[data-team-input="con"]'),
  };

  dom.btnToggle = document.getElementById('btnToggle');
  dom.btnReset = document.getElementById('btnReset');
  dom.btnSwap = document.getElementById('btnSwap');
  dom.selectFormat = document.getElementById('selectFormat');
  dom.btnScript = document.getElementById('btnScript');
  dom.btnWorkshop = document.getElementById('btnWorkshop');
  dom.btnAiWriter = document.getElementById('btnAiWriter');
  dom.btnAiPpt = document.getElementById('btnAiPpt');
  dom.btnPptImport = document.getElementById('btnPptImport');
  dom.btnPptSettings = document.getElementById('btnPptSettings');
}

function bindEvents() {
  dom.btnToggle.addEventListener('click', toggleTimer);
  dom.btnReset.addEventListener('click', resetTimer);
  dom.btnSwap.addEventListener('click', swapSides);
  dom.selectFormat.addEventListener('change', () => {
    void applyFormatSelection();
  });
  dom.btnScript.addEventListener('click', () => {
    void importScriptFile();
  });
  dom.btnWorkshop.addEventListener('click', () => {
    if (workshop) workshop.open();
  });
  dom.btnAiWriter.addEventListener('click', () => {
    if (guides) guides.openWriter();
  });
  dom.btnAiPpt.addEventListener('click', () => {
    if (guides) guides.openPpt();
  });
  dom.btnPptImport.addEventListener('click', () => {
    if (ppt) void ppt.importFile();
  });
  dom.btnPptSettings.addEventListener('click', () => {
    if (ppt) ppt.openSettings();
  });

  document.querySelectorAll('[data-stub]').forEach((btn) => {
    btn.addEventListener('click', () => notify(`${btn.dataset.stub}：功能待接入`));
  });

  dom.topicToggle.addEventListener('click', () => {
    const collapsed = dom.topbar.classList.toggle('is-collapsed');
    dom.topicToggle.setAttribute('aria-expanded', String(!collapsed));
    dom.topicPanel.setAttribute('aria-hidden', String(collapsed));
  });

  dom.topicInput.addEventListener('input', () => {
    state.topic = dom.topicInput.value;
    paintTopicPreview();
    schedulePersist();
  });

  for (const sideId of SIDES) {
    dom.teamInput[sideId].addEventListener('input', () => {
      state.sides[sideId].team = dom.teamInput[sideId].value;
      paintTeam(sideId);
      schedulePersist();
    });
  }

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // 欢迎页 / 帮助页打开时不响应计时快捷键
    if (document.body.dataset.screen !== 'main') return;
    // 工坊 / 设置弹层打开时不响应计时快捷键
    if (document.body.classList.contains('modal-open')) return;
    const target = event.target;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'BUTTON' ||
        target.isContentEditable)
    ) {
      return;
    }

    if (event.code === 'Space') {
      event.preventDefault();
      toggleTimer();
    } else if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      resetTimer();
    } else if (event.key === 's' || event.key === 'S') {
      event.preventDefault();
      swapSides();
    }
  });
}

async function init() {
  cacheDom();
  for (const sideId of SIDES) {
    cells[sideId] = buildTimeDisplay(dom.time[sideId]);
  }
  bindEvents();
  screens = initScreens();
  applyPhase(0);
  paintTeams(true);
  paintTopicPreview();
  paintScriptStatus();
  paintControls();

  await initStore();
  await restoreState();

  workshop = await initWorkshop({ state, persist: persistState, notify });
  guides = initGuides({ notify });
  ppt = initPpt({ state, persist: persistState, notify });

  /* 调试 / 扩展钩子：多环节推进、外部赛制导入都可以从这里接 */
  window.__debate = {
    state,
    applyPhase,
    switchPhase,
    nextPhase,
    loadFormat,
    startTimer,
    pauseTimer,
    resetTimer,
    swapSides,
    parseFormatJson,
    splitScript,
    importFormatFromPath,
    importScriptFromPath,
    persistState,
    formatTime,
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void init();
  });
} else {
  void init();
}
