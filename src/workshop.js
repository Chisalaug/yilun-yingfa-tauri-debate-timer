'use strict';

/* ==========================================================================
 * 文案工坊
 *
 * - 左侧列出 store 里的辩词片段，右侧写指令、流式生成、接受 / 撤销
 * - 所有网络请求走 Rust 命令 stream_completion，前端不 fetch
 * - 监听 stream-chunk / stream-done / stream-error
 * - API Key 存在 plugin-store，不进 localStorage，也不打印到控制台
 * ========================================================================== */

import { invoke } from './vendor/tauri/core.js';
import { listen } from './vendor/tauri/event.js';

const PREVIEW_CHARS = 46;
const ERROR_DEDUPE_MS = 500;

function buildPrompt(instruction, origin) {
  return [
    '请按下面的要求改写给定的中文辩论辩词片段。',
    `要求：${instruction}`,
    '只输出改写后的正文，不要解释，不要加引号。',
    '',
    '原文：',
    origin,
  ].join('\n');
}

export async function initWorkshop({ state, persist, notify }) {
  const $ = (id) => document.getElementById(id);

  const dom = {
    overlay: $('workshopOverlay'),
    list: $('segmentList'),
    count: $('segmentCount'),
    empty: $('segmentEmpty'),
    editorEmpty: $('editorEmpty'),
    editorBody: $('editorBody'),
    origin: $('originText'),
    originMeta: $('originMeta'),
    instruction: $('instructionInput'),
    process: $('btnProcess'),
    status: $('editorStatus'),
    result: $('resultText'),
    resultMeta: $('resultMeta'),
    accept: $('btnAccept'),
    undo: $('btnUndo'),
    settings: $('settingsOverlay'),
    cfgBase: $('cfgBaseUrl'),
    cfgKey: $('cfgApiKey'),
    cfgModel: $('cfgModel'),
  };

  let selected = -1;
  let streaming = false;
  let undoState = null;
  let typeQueue = '';
  let rafId = 0;
  let lastErrorAt = 0;
  let seenError = false;

  /* ---------------- 片段列表 ---------------- */

  function renderSegments() {
    const items = state.scriptSegments;
    dom.count.textContent = String(items.length);
    dom.empty.hidden = items.length > 0;
    dom.list.hidden = items.length === 0;
    dom.list.textContent = '';

    items.forEach((text, index) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `segment-item${index === selected ? ' is-active' : ''}`;

      const meta = document.createElement('span');
      meta.className = 'seg-index';
      meta.textContent = `#${index + 1} · ${text.length} 字`;

      const preview = document.createElement('span');
      preview.className = 'seg-preview';
      const flat = text.replace(/\s+/g, ' ').trim();
      preview.textContent = flat.slice(0, PREVIEW_CHARS) || '（空）';

      btn.append(meta, preview);
      btn.addEventListener('click', () => selectSegment(index));
      li.append(btn);
      dom.list.append(li);
    });
  }

  function selectSegment(index) {
    if (streaming) {
      notify('正在生成，先等这一段写完');
      return;
    }
    selected = index;
    clearResult();
    renderSegments();
    renderEditor();
    dom.instruction.focus();
  }

  function renderEditor() {
    const has = selected >= 0 && selected < state.scriptSegments.length;
    dom.editorEmpty.hidden = has;
    dom.editorBody.hidden = !has;
    dom.undo.disabled = !undoState;
    if (!has) return;

    const text = state.scriptSegments[selected];
    if (dom.origin.textContent !== text) dom.origin.textContent = text;
    dom.originMeta.textContent = `${text.length} 字`;
    dom.accept.disabled = streaming || dom.result.textContent.trim().length === 0;
  }

  /* ---------------- 流式展示（逐字） ---------------- */

  function enqueue(text) {
    typeQueue += text;
    if (!rafId) rafId = requestAnimationFrame(drainQueue);
  }

  function drainQueue() {
    rafId = 0;
    if (!typeQueue) return;
    // 队列越长一次吐得越多，保证不会明显落后于网络
    const step = Math.max(1, Math.ceil(typeQueue.length / 6));
    dom.result.textContent += typeQueue.slice(0, step);
    typeQueue = typeQueue.slice(step);
    dom.result.scrollTop = dom.result.scrollHeight;
    if (typeQueue) rafId = requestAnimationFrame(drainQueue);
  }

  function flushQueue() {
    if (typeQueue) {
      dom.result.textContent += typeQueue;
      typeQueue = '';
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function clearResult() {
    typeQueue = '';
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    dom.result.textContent = '';
    dom.result.classList.remove('is-streaming');
    dom.resultMeta.textContent = '';
    dom.accept.disabled = true;
    setStatus('');
  }

  function setStatus(text) {
    dom.status.textContent = text;
  }

  /* ---------------- 生成 ---------------- */

  function handleError(message) {
    const now = Date.now();
    if (now - lastErrorAt < ERROR_DEDUPE_MS) return; // 事件与 invoke reject 可能同时到达
    lastErrorAt = now;

    seenError = true;
    flushQueue();
    dom.result.classList.remove('is-streaming');
    streaming = false;
    dom.process.disabled = false;
    dom.accept.disabled = dom.result.textContent.trim().length === 0;
    setStatus('生成失败');
    notify(String(message || '生成失败').slice(0, 240));
  }

  async function processSegment() {
    if (streaming) return;
    if (selected < 0) {
      notify('先从左侧选一个片段');
      return;
    }

    const instruction = dom.instruction.value.trim();
    if (!instruction) {
      notify('先写一条写作指令，比如「压缩到 80 字」');
      dom.instruction.focus();
      return;
    }

    const cfg = state.llmConfig || {};
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      notify('先在「接口设置」里填写 Base URL、API Key 和模型');
      openSettings();
      return;
    }

    const origin = state.scriptSegments[selected];
    streaming = true;
    seenError = false;
    clearResult();
    dom.result.classList.add('is-streaming');
    dom.process.disabled = true;
    dom.accept.disabled = true;
    setStatus('正在生成…');

    try {
      await invoke('stream_completion', {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        prompt: buildPrompt(instruction, origin),
      });
      if (!seenError) {
        flushQueue();
        dom.result.classList.remove('is-streaming');
        setStatus(`生成完成 · ${dom.result.textContent.length} 字`);
      }
    } catch (err) {
      if (!seenError) handleError(err);
    } finally {
      streaming = false;
      dom.process.disabled = false;
      dom.accept.disabled = dom.result.textContent.trim().length === 0;
      dom.resultMeta.textContent = dom.result.textContent ? `${dom.result.textContent.length} 字` : '';
    }
  }

  /* ---------------- 接受 / 撤销 ---------------- */

  function acceptResult() {
    if (streaming || selected < 0) return;
    const text = dom.result.textContent.trim();
    if (!text) return;

    const before = state.scriptSegments[selected];
    if (before === text) {
      notify('内容和原文一致，没有需要替换的');
      return;
    }

    state.scriptSegments[selected] = text;
    undoState = { index: selected, before };
    renderSegments();
    renderEditor();
    void persist();
    notify('已替换片段原文，可点「撤销」回退');
  }

  function undoReplace() {
    if (!undoState) return;
    const { index, before } = undoState;
    if (index >= 0 && index < state.scriptSegments.length) {
      state.scriptSegments[index] = before;
      if (selected === index) clearResult();
      renderSegments();
      renderEditor();
      void persist();
      notify('已撤销，恢复原文');
    }
    undoState = null;
    dom.undo.disabled = true;
  }

  /* ---------------- 接口设置 ---------------- */

  function openSettings() {
    const cfg = state.llmConfig || {};
    dom.cfgBase.value = cfg.baseUrl || '';
    dom.cfgKey.value = cfg.apiKey || '';
    dom.cfgModel.value = cfg.model || '';
    dom.settings.hidden = false;
    document.body.classList.add('modal-open');
    dom.cfgBase.focus();
  }

  function closeSettings() {
    dom.settings.hidden = true;
    if (dom.overlay.hidden) document.body.classList.remove('modal-open');
  }

  function saveSettings() {
    state.llmConfig = {
      baseUrl: dom.cfgBase.value.trim(),
      apiKey: dom.cfgKey.value.trim(),
      model: dom.cfgModel.value.trim(),
    };
    void persist();
    closeSettings();
    notify('接口设置已保存');
  }

  /* ---------------- 打开 / 关闭 ---------------- */

  function open() {
    renderSegments();
    if (state.scriptSegments.length === 0) {
      selected = -1;
    } else if (selected < 0 || selected >= state.scriptSegments.length) {
      selected = 0;
    }
    renderEditor();
    dom.overlay.hidden = false;
    document.body.classList.add('modal-open');
    dom.instruction.focus();
  }

  function close() {
    if (!dom.settings.hidden) {
      closeSettings();
      return;
    }
    dom.overlay.hidden = true;
    document.body.classList.remove('modal-open');
  }

  /* ---------------- 事件绑定 ---------------- */

  dom.process.addEventListener('click', () => {
    void processSegment();
  });
  dom.accept.addEventListener('click', acceptResult);
  dom.undo.addEventListener('click', undoReplace);
  $('btnWorkshopClose').addEventListener('click', close);
  $('btnLlmSettings').addEventListener('click', openSettings);
  $('btnSettingsCancel').addEventListener('click', closeSettings);
  $('btnSettingsSave').addEventListener('click', saveSettings);

  dom.settings.addEventListener('click', (event) => {
    if (event.target === dom.settings) closeSettings();
  });
  dom.overlay.addEventListener('click', (event) => {
    if (event.target === dom.overlay) close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!dom.settings.hidden) {
      closeSettings();
    } else if (!dom.overlay.hidden) {
      close();
    }
  });

  await listen('stream-chunk', (event) => {
    const text = event && event.payload ? event.payload.text : '';
    if (typeof text === 'string' && text) enqueue(text);
  });

  await listen('stream-done', () => {
    flushQueue();
    dom.result.classList.remove('is-streaming');
    if (!seenError) {
      setStatus(`生成完成 · ${dom.result.textContent.length} 字`);
      dom.resultMeta.textContent = `${dom.result.textContent.length} 字`;
    }
    dom.accept.disabled = streaming || dom.result.textContent.trim().length === 0;
  });

  await listen('stream-error', (event) => {
    const message = event && event.payload ? event.payload.message : '生成失败';
    handleError(message);
  });

  return { open, close, refresh: renderSegments };
}
