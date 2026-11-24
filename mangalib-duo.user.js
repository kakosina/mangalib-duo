// ==UserScript==
// @name         MangaLib Duo
// @namespace    https://github.com/kakosina/mangalib-duo
// @version      2.8.0
// @description  Double-Page Reader for Mangalib
// @author       kakosina
// @match        https://mangalib.org/*
// @match        https://*.mangalib.org/*
// @match        https://mangalib.me/*
// @match        https://*.mangalib.me/*
// @match        https://*.lib.social/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// @homepageURL  https://github.com/kakosina/mangalib-duo
// @downloadURL  https://raw.githubusercontent.com/kakosina/mangalib-duo/main/mangalib-duo.user.js
// @updateURL    https://raw.githubusercontent.com/kakosina/mangalib-duo/main/mangalib-duo.user.js
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'ml_spread_settings_v2';
  const LEGACY_KEY = 'ml_spread_settings_v1';

  const DEFAULT_SETTINGS = {
    enabled: true,           // Включить режим разворота
    viewMode: 'book',        // 'book' (книга с перелистыванием) | 'vertical' (лента по 2 стр.)
    firstPageSide: 'right',  // 'right' (манга: 2 | 1) | 'left' (комикс: 1 | 2)
    rtlNav: true,            // Листать справа налево (клик слева / ← / A = вперёд)
    flipAnimation: true,     // 3D-анимация перелистывания книги
    coverAlone: false,       // Обложка (1-я стр.) отдельно
    autoWide: true,          // Широкие страницы (двойные сканы) на всю ширину
    fitHeight: true,         // Вписывать разворот по высоте экрана
    gap: 0                   // Зазор между страницами (px)
  };

  function loadSettings() {
    try {
      const readKey = (k) => (typeof GM_getValue === 'function' ? GM_getValue(k, null) : localStorage.getItem(k));
      const raw = readKey(STORAGE_KEY) || readKey(LEGACY_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch (_) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(patch) {
    const prevMode = settings.viewMode;
    const prevEnabled = settings.enabled;
    settings = { ...settings, ...patch };
    try {
      const serialized = JSON.stringify(settings);
      if (typeof GM_setValue === 'function') {
        GM_setValue(STORAGE_KEY, serialized);
      } else {
        localStorage.setItem(STORAGE_KEY, serialized);
      }
    } catch (_) {}

    syncAllSettingsUI();

    // При смене режима сбрасываем предыдущую разметку
    if (prevMode !== settings.viewMode || prevEnabled !== settings.enabled) {
      cleanupAllLayouts();
    }
    scheduleLayout();
  }

  let settings = loadSettings();

  // Состояние текущей главы и книжного режима
  let chapterPages = [];          // [{ index, url, image, fullUrl, width, height }]
  let chapterKey = '';            // "vol_num" из API
  let cdnOrigin = '';             // Определяется автоматически по первой картинке MangaLib
  let currentSpreadIndex = 0;
  let openAtLastSpread = false;   // При переходе на предыдущую главу открывать с конца
  let isFlipping = false;
  let flipTimer = null;
  let hudTimer = null;
  let layoutRaf = null;
  let currentUrl = location.href;
  let hiddenNativeContainer = null;
  let isSyntheticClick = false;
  let touchStartX = null;
  let touchStartY = null;

  // =========================================================================
  // 1. ПЕРЕХВАТ API ГЛАВЫ
  // =========================================================================

  function parseChapterKeyFromUrl(urlStr = location.href) {
    const m = urlStr.match(/\/v([^/?#]+)\/c([^/?#]+)/i);
    return m ? `${m[1]}_${m[2]}` : '';
  }

  function resolveImageUrl(page) {
    if (!page) return '';
    if (page.fullUrl) return page.fullUrl;
    const u = page.url || '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/') && cdnOrigin) return cdnOrigin + u;
    if (page.image && cdnOrigin) return cdnOrigin + (cdnOrigin.endsWith('/') ? '' : '/') + page.image;
    return '';
  }

  function extractChapterPages(payload) {
    try {
      const data = payload?.data || payload;
      if (!data || !Array.isArray(data.pages) || data.pages.length === 0) return;

      const valid = data.pages.every(p => p && (typeof p.url === 'string' || typeof p.image === 'string'));
      if (!valid) return;

      const newKey = (data.volume != null && data.number != null)
        ? `${data.volume}_${data.number}`
        : String(data.id || Date.now());

      const isSameChapter = newKey === chapterKey && chapterPages.length === data.pages.length;

      chapterKey = newKey;
      chapterPages = data.pages.map((p, idx) => ({
        index: idx,
        url: p.url || '',
        image: p.image || '',
        fullUrl: /^https?:\/\//i.test(p.url || '') ? p.url : '',
        width: Number(p.width) || 0,
        height: Number(p.height) || 0
      }));

      if (!isSameChapter) {
        if (openAtLastSpread) {
          const groups = computeSpreadGroups(chapterPages);
          currentSpreadIndex = Math.max(0, groups.length - 1);
          openAtLastSpread = false;
        } else {
          // Учитываем стартовую страницу из URL (?p=5), если указана
          const pParam = Number(new URLSearchParams(location.search).get('p'));
          if (pParam > 1) {
            const groups = computeSpreadGroups(chapterPages);
            const found = groups.findIndex(g => g.includes(pParam - 1));
            currentSpreadIndex = found >= 0 ? found : 0;
          } else {
            currentSpreadIndex = 0;
          }
        }
      }

      scheduleLayout();
    } catch (_) {}
  }

  function hookNetwork() {
    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    if (typeof pageWin.fetch === 'function') {
      const origFetch = pageWin.fetch.bind(pageWin);
      pageWin.fetch = async function (...args) {
        const response = await origFetch(...args);
        try {
          const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
          if (reqUrl.includes('/chapter') || reqUrl.includes('/manga/')) {
            response.clone().json().then(extractChapterPages).catch(() => {});
          }
        } catch (_) {}
        return response;
      };
    }

    const XHRProto = pageWin.XMLHttpRequest?.prototype;
    if (XHRProto) {
      const origOpen = XHRProto.open;
      const origSend = XHRProto.send;
      XHRProto.open = function (method, url, ...rest) {
        this._mlUrl = typeof url === 'string' ? url : '';
        return origOpen.call(this, method, url, ...rest);
      };
      XHRProto.send = function (...args) {
        this.addEventListener('load', function () {
          try {
            if (this._mlUrl && (this._mlUrl.includes('/chapter') || this._mlUrl.includes('/manga/'))) {
              if (this.responseText && this.responseText.startsWith('{')) {
                extractChapterPages(JSON.parse(this.responseText));
              }
            }
          } catch (_) {}
        });
        return origSend.apply(this, args);
      };
    }
  }

  hookNetwork();

  // =========================================================================
  // 2. СТИЛИ (3D-КНИГА, ВЕРТИКАЛЬНЫЙ РАЗВОРОТ И МЕНЮ НАСТРОЕК)
  // =========================================================================

  const STYLES = `
    /* --- Скрытие нативного контейнера в режиме 3D-книги (с сохранением загрузки 1-й картинки для CDN) --- */
    .ml-native-hidden-probe {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 4px !important;
      height: 4px !important;
      opacity: 0 !important;
      overflow: hidden !important;
      pointer-events: none !important;
      z-index: -1 !important;
    }

    .ml-native-hidden-full {
      display: none !important;
    }

    /* --- 3D КНИЖНЫЙ РЕЖИМ --- */
    #ml-book-stage {
      position: relative;
      width: 100%;
      min-height: calc(100vh - 8px);
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
      -webkit-user-select: none;
      overflow: hidden;
      padding: 6px 0;
      box-sizing: border-box;
    }

    #ml-book-stage.ml-fit-height {
      height: 100vh;
      max-height: 100vh;
    }

    .ml-book-viewport {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      perspective: 2400px;
      perspective-origin: 50% 50%;
    }

    .ml-book-spread {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      transform-style: preserve-3d;
    }

    .ml-book-slot {
      position: relative;
      width: 50%;
      height: 100%;
      display: flex;
      align-items: center;
      min-width: 0;
      box-sizing: border-box;
    }

    .ml-book-slot.is-left {
      justify-content: flex-end;
      padding-right: calc(var(--ml-spread-gap, 0px) / 2);
    }

    .ml-book-slot.is-right {
      justify-content: flex-start;
      padding-left: calc(var(--ml-spread-gap, 0px) / 2);
    }

    .ml-book-solo-slot {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Лист бумаги с реалистичной тенью у корешка */
    .ml-page-sheet {
      position: relative;
      display: inline-flex;
      max-width: 100%;
      max-height: 100%;
      overflow: hidden;
      background: #111;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    }

    .ml-page-sheet > img {
      display: block;
      max-width: 100%;
      width: auto;
      height: auto;
      object-fit: contain;
      pointer-events: none;
    }

    #ml-book-stage.ml-fit-height .ml-page-sheet > img {
      max-height: calc(100vh - 20px);
    }

    .ml-book-slot .ml-page-sheet > img {
      max-width: 50vw;
    }

    .ml-book-solo-slot .ml-page-sheet > img {
      max-width: 98vw;
    }

    /* Эффект сгиба (корешка) книги на стыке двух страниц */
    .ml-page-sheet.is-left-page::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(
        to left,
        rgba(0, 0, 0, 0.34) 0%,
        rgba(0, 0, 0, 0.12) 10px,
        rgba(255, 255, 255, 0.04) 22px,
        transparent 42px
      );
    }

    .ml-page-sheet.is-right-page::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(
        to right,
        rgba(0, 0, 0, 0.34) 0%,
        rgba(0, 0, 0, 0.12) 10px,
        rgba(255, 255, 255, 0.04) 22px,
        transparent 42px
      );
    }

    /* 3D перелистываемый лист */
    .ml-book-flipper {
      position: absolute;
      top: 0;
      height: 100%;
      width: 50%;
      transform-style: preserve-3d;
      z-index: 6;
      pointer-events: none;
      will-change: transform;
    }

    .ml-book-flipper.turn-l2r {
      left: 0;
      transform-origin: right center;
      animation: mlFlipLeftToRight 480ms cubic-bezier(0.32, 0.08, 0.24, 1) forwards;
    }

    .ml-book-flipper.turn-r2l {
      left: 50%;
      transform-origin: left center;
      animation: mlFlipRightToLeft 480ms cubic-bezier(0.32, 0.08, 0.24, 1) forwards;
    }

    .ml-flip-face {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
    }

    .ml-book-flipper.turn-l2r .ml-flip-face.is-front {
      justify-content: flex-end;
    }

    .ml-book-flipper.turn-l2r .ml-flip-face.is-back {
      justify-content: flex-start;
      transform: rotateY(180deg);
    }

    .ml-book-flipper.turn-r2l .ml-flip-face.is-front {
      justify-content: flex-start;
    }

    .ml-book-flipper.turn-r2l .ml-flip-face.is-back {
      justify-content: flex-end;
      transform: rotateY(180deg);
    }

    /* Динамическое затенение на переворачиваемой странице */
    .ml-flip-shade {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: #000;
      opacity: 0;
    }

    .ml-flip-face.is-front .ml-flip-shade {
      animation: mlShadeFront 480ms cubic-bezier(0.32, 0.08, 0.24, 1) forwards;
    }

    .ml-flip-face.is-back .ml-flip-shade {
      animation: mlShadeBack 480ms cubic-bezier(0.32, 0.08, 0.24, 1) forwards;
    }

    /* Тень, падающая на открывающуюся/накрываемую страницу под листом */
    .ml-under-shadow {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: #000;
      opacity: 0;
      z-index: 2;
    }

    .ml-under-shadow.is-revealing {
      animation: mlUnderReveal 480ms ease-out forwards;
    }

    .ml-under-shadow.is-covering {
      animation: mlUnderCover 480ms ease-in forwards;
    }

    /* Плавная 3D-анимация для одиночных/широких страниц */
    .ml-solo-enter-l2r {
      animation: mlSoloEnterL2R 340ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }

    .ml-solo-enter-r2l {
      animation: mlSoloEnterR2L 340ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }

    @keyframes mlFlipLeftToRight {
      0%   { transform: rotateY(0deg); }
      100% { transform: rotateY(180deg); }
    }

    @keyframes mlFlipRightToLeft {
      0%   { transform: rotateY(0deg); }
      100% { transform: rotateY(-180deg); }
    }

    @keyframes mlShadeFront {
      0%   { opacity: 0; }
      50%  { opacity: 0.42; }
      100% { opacity: 0.55; }
    }

    @keyframes mlShadeBack {
      0%   { opacity: 0.55; }
      50%  { opacity: 0.38; }
      100% { opacity: 0; }
    }

    @keyframes mlUnderReveal {
      0%   { opacity: 0.48; }
      45%  { opacity: 0.28; }
      100% { opacity: 0; }
    }

    @keyframes mlUnderCover {
      0%   { opacity: 0; }
      55%  { opacity: 0.25; }
      100% { opacity: 0.45; }
    }

    @keyframes mlSoloEnterL2R {
      0%   { opacity: 0; transform: translateX(-28px) rotateY(8deg) scale(0.985); }
      100% { opacity: 1; transform: translateX(0) rotateY(0deg) scale(1); }
    }

    @keyframes mlSoloEnterR2L {
      0%   { opacity: 0; transform: translateX(28px) rotateY(-8deg) scale(0.985); }
      100% { opacity: 1; transform: translateX(0) rotateY(0deg) scale(1); }
    }

    /* Зоны клика поверх книги */
    .ml-book-zones {
      position: absolute;
      inset: 0;
      display: grid;
      grid-template-columns: 38% 24% 38%;
      z-index: 10;
    }

    .ml-zone-left { cursor: w-resize; }
    .ml-zone-center { cursor: pointer; }
    .ml-zone-right { cursor: e-resize; }

    /* Компактный индикатор страниц внизу (появляется при перелистывании/наведении) */
    .ml-book-hud {
      position: fixed;
      bottom: 14px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 25;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 14px;
      border-radius: 999px;
      background: rgba(20, 20, 24, 0.78);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #f2f2f7;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      opacity: 0.22;
      transition: opacity 0.25s ease;
      pointer-events: auto;
    }

    .ml-book-hud.is-visible,
    .ml-book-hud:hover {
      opacity: 1;
    }

    .ml-hud-pill {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(242, 124, 34, 0.22);
      color: #ff9c52;
      letter-spacing: 0.02em;
    }

    .ml-book-toast {
      position: fixed;
      top: 72px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 99999;
      padding: 8px 16px;
      border-radius: 8px;
      background: rgba(20, 20, 24, 0.9);
      color: #ffffff;
      font-size: 13px;
      font-weight: 500;
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
      pointer-events: none;
      animation: mlToastFade 1.5s ease forwards;
    }

    @keyframes mlToastFade {
      0%   { opacity: 0; transform: translate(-50%, -6px); }
      15%  { opacity: 1; transform: translate(-50%, 0); }
      80%  { opacity: 1; transform: translate(-50%, 0); }
      100% { opacity: 0; transform: translate(-50%, -4px); }
    }

    /* --- ВЕРТИКАЛЬНЫЙ РЕЖИМ (ЛЕНТА ПО 2 СТР.) --- */
    .ml-spread-width-unlock {
      max-width: 100vw !important;
      width: 100% !important;
    }

    .ml-spread-vertical-grid {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
      row-gap: 10px !important;
      column-gap: var(--ml-spread-gap, 0px) !important;
      width: 100% !important;
      max-width: 100vw !important;
      margin-left: auto !important;
      margin-right: auto !important;
      align-items: center !important;
      box-sizing: border-box !important;
    }

    .ml-spread-vertical-grid > .ml-spread-left {
      grid-column: 1 / 2 !important;
      display: flex !important;
      justify-content: flex-end !important;
      align-items: center !important;
      width: 100% !important;
      min-width: 0 !important;
      margin: 0 !important;
    }

    .ml-spread-vertical-grid > .ml-spread-right {
      grid-column: 2 / 3 !important;
      display: flex !important;
      justify-content: flex-start !important;
      align-items: center !important;
      width: 100% !important;
      min-width: 0 !important;
      margin: 0 !important;
    }

    .ml-spread-vertical-grid > .ml-spread-full,
    .ml-spread-vertical-grid > .ml-spread-nonpage {
      grid-column: 1 / 3 !important;
      display: flex !important;
      justify-content: center !important;
      align-items: center !important;
      width: 100% !important;
      min-width: 0 !important;
      margin: 0 auto !important;
    }

    .ml-spread-vertical-grid > .ml-spread-left > div { display: flex !important; justify-content: flex-end !important; width: 100% !important; }
    .ml-spread-vertical-grid > .ml-spread-right > div { display: flex !important; justify-content: flex-start !important; width: 100% !important; }
    .ml-spread-vertical-grid > .ml-spread-full > div { display: flex !important; justify-content: center !important; width: 100% !important; }

    .ml-spread-vertical-grid img {
      max-width: 100% !important;
      width: auto !important;
      height: auto !important;
      object-fit: contain !important;
      margin: 0 !important;
      display: block !important;
    }

    .ml-spread-vertical-grid.ml-fit-height img {
      max-height: calc(100vh - 16px) !important;
    }

    /* --- БЛОК НАСТРОЕК ВНУТРИ МЕНЮ MANGALIB --- */
    #ml-spread-settings-block,
    [data-ml-spread-settings="1"] {
      margin: 12px 0;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid rgba(128, 128, 128, 0.25);
      background: rgba(128, 128, 128, 0.08);
      font-family: inherit;
      font-size: 14px;
      line-height: 1.4;
      color: inherit;
    }

    .ml-ss-title {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .ml-ss-badge {
      font-size: 11px;
      font-weight: 500;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(242, 124, 34, 0.18);
      color: #f27c22;
    }

    .ml-ss-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 6px 0;
    }

    .ml-ss-row + .ml-ss-row {
      border-top: 1px solid rgba(128, 128, 128, 0.14);
    }

    .ml-ss-block-col {
      display: flex;
      flex-direction: column;
      padding: 6px 0;
      border-top: 1px solid rgba(128, 128, 128, 0.14);
    }

    .ml-ss-label {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 13px;
    }

    .ml-ss-sub {
      font-size: 11px;
      opacity: 0.65;
    }

    .ml-ss-switch {
      position: relative;
      display: inline-block;
      width: 38px;
      height: 22px;
      flex-shrink: 0;
      cursor: pointer;
    }

    .ml-ss-switch input {
      opacity: 0;
      width: 0;
      height: 0;
      position: absolute;
    }

    .ml-ss-slider {
      position: absolute;
      inset: 0;
      background: rgba(128, 128, 128, 0.35);
      border-radius: 999px;
      transition: background 0.2s ease;
    }

    .ml-ss-slider::before {
      content: "";
      position: absolute;
      width: 16px;
      height: 16px;
      left: 3px;
      top: 3px;
      border-radius: 50%;
      background: #ffffff;
      transition: transform 0.2s ease;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    }

    .ml-ss-switch input:checked + .ml-ss-slider {
      background: #f27c22;
    }

    .ml-ss-switch input:checked + .ml-ss-slider::before {
      transform: translateX(16px);
    }

    .ml-ss-segmented {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      padding: 3px;
      border-radius: 8px;
      background: rgba(128, 128, 128, 0.16);
      margin-top: 6px;
      width: 100%;
    }

    .ml-ss-seg-btn {
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 12px;
      font-weight: 500;
      padding: 6px 8px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
      text-align: center;
    }

    .ml-ss-seg-btn.is-active {
      background: #f27c22;
      color: #ffffff;
    }

    .ml-ss-disabled-group {
      opacity: 0.45;
      pointer-events: none;
    }

    /* Резервная модалка (из меню Tampermonkey) */
    #ml-spread-fallback-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: rgba(0, 0, 0, 0.62);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }

    #ml-spread-fallback-modal {
      width: 100%;
      max-width: 390px;
      background: #1c1c1e;
      color: #f2f2f7;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.12);
    }

    .ml-ss-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      font-weight: 600;
      font-size: 15px;
    }

    .ml-ss-modal-close {
      background: transparent;
      border: none;
      color: inherit;
      font-size: 20px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
      opacity: 0.7;
    }

    .ml-ss-modal-close:hover { opacity: 1; }
  `;

  function injectStyles() {
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(STYLES);
    } else {
      const style = document.createElement('style');
      style.textContent = STYLES;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  // =========================================================================
  // 3. ПОМОЩНИКИ ДЛЯ ЧИТАЛКИ И РАЗБИЕНИЯ НА РАЗВОРОТЫ
  // =========================================================================

  function isReaderPage() {
    return /\/read\/|\/v\d+\/c[\d.]+/i.test(location.pathname);
  }

  function isLikelyMangaImage(img) {
    if (!img || img.closest('#ml-book-stage, #ml-spread-settings-block, #ml-spread-fallback-backdrop')) return false;
    if (img.closest('header, nav, footer, [role="dialog"]')) return false;
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
    if (!src) return false;
    if (/avatar|logo|icon|emoji|sticker|badge/i.test(src)) return false;
    if (img.closest('[data-p], [data-page], [data-media-id]')) return true;
    if (/\/manga\/|imgslib|cdnlibs|mixlib|mangalib/i.test(src)) return true;
    if (img.naturalWidth >= 300 || img.clientWidth >= 250) return true;
    return false;
  }

  function isWidePage(meta, img) {
    if (!settings.autoWide) return false;
    const w = meta?.width || img?.naturalWidth || 0;
    const h = meta?.height || img?.naturalHeight || 0;
    return w > 0 && h > 0 && w > h * 1.15;
  }

  function getNativeReaderImages() {
    const root = document.querySelector('main') || document.body;
    if (!root) return [];
    return Array.from(root.querySelectorAll('img')).filter(isLikelyMangaImage);
  }

  function detectCdnAndFallbackPages() {
    const nativeImgs = getNativeReaderImages();

    // 1. Определяем актуальный домен сервера картинок по первой загруженной картинке
    if (!cdnOrigin) {
      for (const img of nativeImgs) {
        const src = img.currentSrc || img.src || '';
        if (!/^https?:\/\//i.test(src)) continue;

        for (const p of chapterPages) {
          if (p.url && src.endsWith(p.url)) {
            cdnOrigin = src.slice(0, src.length - p.url.length);
            break;
          }
          if (p.image && src.endsWith('/' + p.image)) {
            const idx = p.url ? src.lastIndexOf(p.url) : -1;
            cdnOrigin = idx > 0 ? src.slice(0, idx) : new URL(src).origin;
            break;
          }
        }
        if (cdnOrigin) break;

        try {
          if (/imgslib|mixlib|cdnlibs|\/manga\//i.test(src)) {
            cdnOrigin = new URL(src).origin;
            break;
          }
        } catch (_) {}
      }
    }

    // 2. Резерв: если скрипт включили уже после загрузки главы и API не перехватился — собираем страницы из DOM
    if (chapterPages.length === 0 && nativeImgs.length >= 2) {
      chapterPages = nativeImgs.map((img, idx) => ({
        index: idx,
        url: img.currentSrc || img.src || img.getAttribute('data-src') || '',
        image: '',
        fullUrl: img.currentSrc || img.src || img.getAttribute('data-src') || '',
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0
      })).filter(p => Boolean(p.fullUrl));
      chapterKey = parseChapterKeyFromUrl() || 'dom';
    }

    return nativeImgs;
  }

  function findNativeContainer(images) {
    if (!images.length) return null;
    if (images.length === 1) {
      return images[0].closest('[data-p], [data-page], [class*="reader"], [class*="page"]')?.parentElement || images[0].parentElement;
    }

    const getAncestors = (el) => {
      const list = [];
      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        list.push(cur);
        cur = cur.parentElement;
      }
      return list;
    };

    const firstAncestors = getAncestors(images[0]);
    for (const candidate of firstAncestors) {
      if (images.every(el => candidate.contains(el))) {
        return candidate;
      }
    }
    return null;
  }

  function computeSpreadGroups(pages) {
    const groups = [];
    let current = [];

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const isCover = settings.coverAlone && i === 0;
      const isWide = isWidePage(p);

      if (isCover || isWide) {
        if (current.length) {
          groups.push({ pages: current, solo: false });
          current = [];
        }
        groups.push({ pages: [i], solo: true, isWide });
      } else {
        current.push(i);
        if (current.length === 2) {
          groups.push({ pages: current, solo: false });
          current = [];
        }
      }
    }
    if (current.length) {
      groups.push({ pages: current, solo: false });
    }
    return groups;
  }

  // Возвращает { leftPage, rightPage, soloPage } для группы
  function mapGroupToSlots(group) {
    if (!group) return { left: null, right: null, solo: null };
    if (group.solo) {
      return { left: null, right: null, solo: chapterPages[group.pages[0]] || null };
    }
    const p1 = chapterPages[group.pages[0]] || null;
    const p2 = chapterPages[group.pages[1]] || null;
    if (settings.firstPageSide === 'right') {
      // Манга: справа 1-я, слева 2-я (2 | 1)
      return { left: p2, right: p1, solo: null };
    }
    // Комикс: слева 1-я, справа 2-я (1 | 2)
    return { left: p1, right: p2, solo: null };
  }

  function showToast(text) {
    document.querySelectorAll('.ml-book-toast').forEach(el => el.remove());
    const toast = document.createElement('div');
    toast.className = 'ml-book-toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 1550);
  }

  // =========================================================================
  // 4. РЕЖИМ 3D-КНИГИ (АНИМАЦИЯ ПЕРЕЛИСТЫВАНИЯ + RTL НАВИГАЦИЯ)
  // =========================================================================

  function createPageSheetEl(pageMeta, sideClass) {
    if (!pageMeta) return null;
    const url = resolveImageUrl(pageMeta);
    if (!url) return null;

    const sheet = document.createElement('div');
    sheet.className = `ml-page-sheet ${sideClass}`;

    const img = document.createElement('img');
    img.src = url;
    img.alt = `Страница ${pageMeta.index + 1}`;
    img.draggable = false;

    img.addEventListener('load', () => {
      if (!pageMeta.width || !pageMeta.height) {
        const wasWide = isWidePage(pageMeta);
        pageMeta.width = img.naturalWidth;
        pageMeta.height = img.naturalHeight;
        if (settings.autoWide && !wasWide && isWidePage(pageMeta)) {
          renderBookSpread(false);
        }
      }
    }, { once: true });

    sheet.appendChild(img);
    return sheet;
  }

  function preloadSpread(groups, idx) {
    const g = groups[idx];
    if (!g) return;
    for (const pageIdx of g.pages) {
      const meta = chapterPages[pageIdx];
      const url = resolveImageUrl(meta);
      if (!url || meta._preloaded) continue;
      meta._preloaded = true;
      const pre = new Image();
      pre.onload = () => {
        if (!meta.width || !meta.height) {
          meta.width = pre.naturalWidth;
          meta.height = pre.naturalHeight;
        }
      };
      pre.src = url;
    }
  }

  function ensureBookStage(nativeContainer) {
    let stage = document.getElementById('ml-book-stage');
    if (stage) return stage;

    stage = document.createElement('div');
    stage.id = 'ml-book-stage';

    stage.innerHTML = `
      <div class="ml-book-viewport">
        <div class="ml-book-spread"></div>
      </div>
      <div class="ml-book-zones">
        <div class="ml-zone-left"></div>
        <div class="ml-zone-center"></div>
        <div class="ml-zone-right"></div>
      </div>
      <div class="ml-book-hud"></div>
    `;

    // Обработчики кликов по зонам (левая / центр / правая)
    stage.querySelector('.ml-zone-left').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // В режиме манги (RTL) клик слева = СЛЕДУЮЩИЙ разворот
      stepSpread(settings.rtlNav ? 1 : -1);
    });

    stage.querySelector('.ml-zone-right').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // В режиме манги (RTL) клик справа = ПРЕДЫДУЩИЙ разворот
      stepSpread(settings.rtlNav ? -1 : 1);
    });

    stage.querySelector('.ml-zone-center').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleNativeHud();
    });

    // Свайпы на тачскрине / трекпаде
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    stage.addEventListener('touchend', (e) => {
      if (touchStartX === null || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      touchStartX = null;
      touchStartY = null;

      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        // Физически тянем страницу: вправо -> перелистнуть левую (RTL вперёд), влево -> перелистнуть правую (LTR вперёд)
        const swipedRight = dx > 0;
        if (settings.rtlNav) {
          stepSpread(swipedRight ? 1 : -1);
        } else {
          stepSpread(swipedRight ? -1 : 1);
        }
      }
    }, { passive: true });

    if (nativeContainer && nativeContainer.parentElement) {
      nativeContainer.insertAdjacentElement('afterend', stage);
    } else {
      (document.querySelector('main') || document.body).appendChild(stage);
    }

    return stage;
  }

  function toggleNativeHud() {
    // Показываем наш HUD и пробуем переключить верхнюю панель MangaLib кликом по центру
    flashHud();
    if (!hiddenNativeContainer) return;
    isSyntheticClick = true;
    try {
      const target = hiddenNativeContainer.querySelector('img') || hiddenNativeContainer;
      target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(window.innerWidth / 2),
        clientY: Math.round(window.innerHeight / 2)
      }));
    } finally {
      setTimeout(() => { isSyntheticClick = false; }, 30);
    }
  }

  function flashHud() {
    const hud = document.querySelector('#ml-book-stage .ml-book-hud');
    if (!hud) return;
    hud.classList.add('is-visible');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud.classList.remove('is-visible'), 2000);
  }

  function updateHud(stage, groups) {
    const hud = stage.querySelector('.ml-book-hud');
    if (!hud) return;

    const group = groups[currentSpreadIndex];
    const total = chapterPages.length;
    let label = '';

    if (group) {
      if (group.pages.length === 2) {
        const a = group.pages[0] + 1;
        const b = group.pages[1] + 1;
        label = settings.firstPageSide === 'right' ? `Стр. ${b}–${a} / ${total}` : `Стр. ${a}–${b} / ${total}`;
      } else {
        label = `Стр. ${group.pages[0] + 1} / ${total}`;
      }
    }

    const dirBadge = settings.rtlNav ? '← Манга (RTL)' : 'Комикс (LTR) →';
    hud.innerHTML = `<span>${label}</span><span class="ml-hud-pill">${dirBadge}</span>`;

    const leftZone = stage.querySelector('.ml-zone-left');
    const rightZone = stage.querySelector('.ml-zone-right');
    if (leftZone && rightZone) {
      leftZone.title = settings.rtlNav ? 'Следующий разворот (←)' : 'Предыдущий разворот (←)';
      rightZone.title = settings.rtlNav ? 'Предыдущий разворот (→)' : 'Следующий разворот (→)';
    }
  }

  function renderStaticSpread(spreadEl, slots, soloAnimClass = '') {
    spreadEl.innerHTML = '';

    if (slots.solo) {
      const soloWrap = document.createElement('div');
      soloWrap.className = `ml-book-solo-slot ${soloAnimClass}`.trim();
      const sheet = createPageSheetEl(slots.solo, 'is-solo-page');
      if (sheet) soloWrap.appendChild(sheet);
      spreadEl.appendChild(soloWrap);
      return;
    }

    const leftSlot = document.createElement('div');
    leftSlot.className = 'ml-book-slot is-left';
    const leftSheet = createPageSheetEl(slots.left, 'is-left-page');
    if (leftSheet) leftSlot.appendChild(leftSheet);

    const rightSlot = document.createElement('div');
    rightSlot.className = 'ml-book-slot is-right';
    const rightSheet = createPageSheetEl(slots.right, 'is-right-page');
    if (rightSheet) rightSlot.appendChild(rightSheet);

    spreadEl.appendChild(leftSlot);
    spreadEl.appendChild(rightSlot);
  }

  // Физический 3D-переворот листа вокруг центрального корешка
  function animateBookFlip(spreadEl, oldSlots, newSlots, turnDirection, onDone) {
    // turnDirection: 'l2r' (левая страница перекидывается направо) | 'r2l' (правая перекидывается налево)
    spreadEl.innerHTML = '';

    // 1. Статические базовые слоты (под перелистываемым листом)
    const leftSlot = document.createElement('div');
    leftSlot.className = 'ml-book-slot is-left';
    const baseLeftMeta = turnDirection === 'l2r' ? newSlots.left : oldSlots.left;
    const baseLeftSheet = createPageSheetEl(baseLeftMeta, 'is-left-page');
    if (baseLeftSheet) {
      const underShadow = document.createElement('div');
      underShadow.className = `ml-under-shadow ${turnDirection === 'l2r' ? 'is-revealing' : 'is-covering'}`;
      baseLeftSheet.appendChild(underShadow);
      leftSlot.appendChild(baseLeftSheet);
    }

    const rightSlot = document.createElement('div');
    rightSlot.className = 'ml-book-slot is-right';
    const baseRightMeta = turnDirection === 'l2r' ? oldSlots.right : newSlots.right;
    const baseRightSheet = createPageSheetEl(baseRightMeta, 'is-right-page');
    if (baseRightSheet) {
      const underShadow = document.createElement('div');
      underShadow.className = `ml-under-shadow ${turnDirection === 'l2r' ? 'is-covering' : 'is-revealing'}`;
      baseRightSheet.appendChild(underShadow);
      rightSlot.appendChild(baseRightSheet);
    }

    // 2. Переворачиваемый 3D-лист (лицевая и оборотная стороны)
    const flipper = document.createElement('div');
    flipper.className = `ml-book-flipper ${turnDirection === 'l2r' ? 'turn-l2r' : 'turn-r2l'}`;

    const frontFace = document.createElement('div');
    frontFace.className = 'ml-flip-face is-front';
    const frontMeta = turnDirection === 'l2r' ? oldSlots.left : oldSlots.right;
    const frontSheet = createPageSheetEl(frontMeta, turnDirection === 'l2r' ? 'is-left-page' : 'is-right-page');
    if (frontSheet) {
      const shade = document.createElement('div');
      shade.className = 'ml-flip-shade';
      frontSheet.appendChild(shade);
      frontFace.appendChild(frontSheet);
    }

    const backFace = document.createElement('div');
    backFace.className = 'ml-flip-face is-back';
    const backMeta = turnDirection === 'l2r' ? newSlots.right : newSlots.left;
    const backSheet = createPageSheetEl(backMeta, turnDirection === 'l2r' ? 'is-right-page' : 'is-left-page');
    if (backSheet) {
      const shade = document.createElement('div');
      shade.className = 'ml-flip-shade';
      backSheet.appendChild(shade);
      backFace.appendChild(backSheet);
    }

    flipper.appendChild(frontFace);
    flipper.appendChild(backFace);

    spreadEl.appendChild(leftSlot);
    spreadEl.appendChild(rightSlot);
    spreadEl.appendChild(flipper);

    isFlipping = true;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(flipTimer);
      isFlipping = false;
      onDone();
    };

    flipper.addEventListener('animationend', (e) => {
      if (e.target === flipper) finish();
    }, { once: true });

    flipTimer = setTimeout(finish, 560);
  }

  function renderBookSpread(animate = false, prevIndex = currentSpreadIndex, stepDir = 1) {
    const stage = document.getElementById('ml-book-stage');
    if (!stage || !chapterPages.length) return;

    const groups = computeSpreadGroups(chapterPages);
    if (!groups.length) return;

    currentSpreadIndex = Math.max(0, Math.min(currentSpreadIndex, groups.length - 1));
    stage.classList.toggle('ml-fit-height', settings.fitHeight);
    stage.style.setProperty('--ml-spread-gap', `${settings.gap}px`);

    const spreadEl = stage.querySelector('.ml-book-spread');
    const newGroup = groups[currentSpreadIndex];
    const oldGroup = groups[prevIndex];
    const newSlots = mapGroupToSlots(newGroup);
    const oldSlots = mapGroupToSlots(oldGroup);

    // Определяем физическое направление перекидывания листа:
    // В манге (firstPageSide === 'right'): шаг вперёд (+1) перекидывает ЛЕВУЮ страницу направо ('l2r').
    // В комиксе (firstPageSide === 'left'): шаг вперёд (+1) перекидывает ПРАВУЮ страницу налево ('r2l').
    const isForward = stepDir > 0;
    const turnDirection = (settings.firstPageSide === 'right')
      ? (isForward ? 'l2r' : 'r2l')
      : (isForward ? 'r2l' : 'l2r');

    if (animate && settings.flipAnimation && oldGroup && prevIndex !== currentSpreadIndex) {
      if (!oldGroup.solo && !newGroup.solo) {
        animateBookFlip(spreadEl, oldSlots, newSlots, turnDirection, () => {
          renderStaticSpread(spreadEl, newSlots);
        });
      } else {
        // Плавный направленный переход для широких/одиночных страниц
        renderStaticSpread(spreadEl, newSlots, turnDirection === 'l2r' ? 'ml-solo-enter-l2r' : 'ml-solo-enter-r2l');
      }
    } else {
      renderStaticSpread(spreadEl, newSlots);
    }

    updateHud(stage, groups);
    flashHud();

    // Подгружаем соседние развороты заранее для мгновенного перелистывания
    preloadSpread(groups, currentSpreadIndex + 1);
    preloadSpread(groups, currentSpreadIndex + 2);
    preloadSpread(groups, currentSpreadIndex - 1);
  }

  function stepSpread(delta) {
    if (!chapterPages.length) return;

    const groups = computeSpreadGroups(chapterPages);
    if (!groups.length) return;

    // Если пользователь быстро листает во время анимации — завершаем её мгновенно
    if (isFlipping) {
      clearTimeout(flipTimer);
      isFlipping = false;
    }

    const nextIdx = currentSpreadIndex + delta;

    if (nextIdx >= groups.length) {
      goToAdjacentChapter(1);
      return;
    }
    if (nextIdx < 0) {
      goToAdjacentChapter(-1);
      return;
    }

    const prevIdx = currentSpreadIndex;
    currentSpreadIndex = nextIdx;
    renderBookSpread(true, prevIdx, delta);
  }

  function goToAdjacentChapter(direction) {
    // Ищем штатные ссылки на следующую / предыдущую главу в шапке или на странице MangaLib
    const links = Array.from(document.querySelectorAll('a[href*="/read/"]')).filter(a => {
      if (a.closest('#ml-spread-settings-block, #ml-spread-fallback-backdrop')) return false;
      return a.href && a.href !== location.href;
    });

    const matchByLabel = (rx) => links.find(a => {
      const txt = `${a.textContent || ''} ${a.getAttribute('title') || ''} ${a.getAttribute('aria-label') || ''}`;
      return rx.test(txt);
    });

    let target = direction > 0
      ? matchByLabel(/следующ|next|впер[её]д/i)
      : matchByLabel(/предыдущ|prev|назад/i);

    if (!target) {
      // Фолбэк: ссылки переключения глав в шапке читалки (обычно левая = пред., правая = след.)
      const headerLinks = Array.from(document.querySelectorAll('header a[href*="/read/"], nav a[href*="/read/"]'))
        .filter(a => a.href && a.href !== location.href);
      if (headerLinks.length >= 2) {
        target = direction > 0 ? headerLinks[headerLinks.length - 1] : headerLinks[0];
      }
    }

    if (target) {
      openAtLastSpread = direction < 0;
      showToast(direction > 0 ? 'Переход к следующей главе…' : 'Переход к предыдущей главе…');
      target.click();
    } else {
      showToast(direction > 0 ? 'Это последняя страница главы' : 'Это первая страница главы');
    }
  }

  function applyBookMode() {
    const nativeImgs = detectCdnAndFallbackPages();
    const nativeContainer = findNativeContainer(nativeImgs);

    // Если есть страницы и удалось определить URL картинок — запускаем 3D-книгу
    if (!chapterPages.length) return;
    const firstUrl = resolveImageUrl(chapterPages[0]);
    if (!firstUrl) return;

    if (nativeContainer && nativeContainer !== hiddenNativeContainer) {
      restoreNativeContainer();
      hiddenNativeContainer = nativeContainer;
    }

    if (hiddenNativeContainer) {
      hiddenNativeContainer.classList.remove('ml-native-hidden-probe');
      hiddenNativeContainer.classList.add('ml-native-hidden-full');
    }

    const stage = ensureBookStage(hiddenNativeContainer);
    const spreadEl = stage.querySelector('.ml-book-spread');

    // Рендерим, если сцена ещё пустая или сменилась глава
    if (!spreadEl.children.length || stage.dataset.chapterKey !== chapterKey || stage.dataset.layoutSig !== getLayoutSignature()) {
      stage.dataset.chapterKey = chapterKey;
      stage.dataset.layoutSig = getLayoutSignature();
      renderBookSpread(false);
    }
  }

  function getLayoutSignature() {
    return `${settings.firstPageSide}_${settings.rtlNav}_${settings.coverAlone}_${settings.autoWide}_${settings.fitHeight}_${settings.gap}`;
  }

  // =========================================================================
  // 5. ВЕРТИКАЛЬНЫЙ РЕЖИМ (ЛЕНТА ПО 2 СТРАНИЦЫ)
  // =========================================================================

  function getDirectChildFor(container, descendant) {
    let cur = descendant;
    while (cur && cur.parentElement !== container) {
      cur = cur.parentElement;
    }
    return cur;
  }

  function unlockAncestorsWidth(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      cur.classList.add('ml-spread-width-unlock');
      if (cur.tagName === 'MAIN') break;
      cur = cur.parentElement;
    }
  }

  function applyVerticalSpread() {
    const images = getNativeReaderImages();
    if (images.length < 2) return;

    const container = findNativeContainer(images);
    if (!container) return;

    unlockAncestorsWidth(container);
    container.classList.add('ml-spread-vertical-grid');
    container.classList.toggle('ml-fit-height', settings.fitHeight);
    container.style.setProperty('--ml-spread-gap', `${settings.gap}px`);

    const pageChildToImg = new Map();
    for (const img of images) {
      const child = getDirectChildFor(container, img);
      if (child && !pageChildToImg.has(child)) {
        pageChildToImg.set(child, img);
        if (!img.dataset.mlSpreadBound) {
          img.dataset.mlSpreadBound = '1';
          img.addEventListener('load', scheduleLayout);
        }
      }
    }

    const children = Array.from(container.children);
    let row = 1;
    let firstInPair = true;
    let pageCounter = 0;

    for (const child of children) {
      child.classList.remove('ml-spread-left', 'ml-spread-right', 'ml-spread-full', 'ml-spread-nonpage');
      const img = pageChildToImg.get(child);

      if (!img) {
        if (!firstInPair) { row++; firstInPair = true; }
        child.classList.add('ml-spread-nonpage');
        child.style.gridRow = String(row++);
        continue;
      }

      const isCover = settings.coverAlone && pageCounter === 0;
      const isWide = isWidePage(null, img);
      pageCounter++;

      if (isCover || isWide) {
        if (!firstInPair) { row++; firstInPair = true; }
        child.classList.add('ml-spread-full');
        child.style.gridRow = String(row++);
        continue;
      }

      if (firstInPair) {
        child.classList.add(settings.firstPageSide === 'right' ? 'ml-spread-right' : 'ml-spread-left');
        child.style.gridRow = String(row);
        firstInPair = false;
      } else {
        child.classList.add(settings.firstPageSide === 'right' ? 'ml-spread-left' : 'ml-spread-right');
        child.style.gridRow = String(row++);
        firstInPair = true;
      }
    }
  }

  // =========================================================================
  // 6. ОЧИСТКА И ДИСПЕТЧЕР РЕЖИМОВ
  // =========================================================================

  function restoreNativeContainer() {
    if (hiddenNativeContainer) {
      hiddenNativeContainer.classList.remove('ml-native-hidden-probe', 'ml-native-hidden-full');
      hiddenNativeContainer = null;
    }
  }

  function cleanupAllLayouts() {
    clearTimeout(flipTimer);
    isFlipping = false;

    const stage = document.getElementById('ml-book-stage');
    if (stage) stage.remove();

    restoreNativeContainer();

    document.querySelectorAll('.ml-spread-vertical-grid').forEach(container => {
      container.classList.remove('ml-spread-vertical-grid', 'ml-fit-height');
      container.style.removeProperty('--ml-spread-gap');
      Array.from(container.children).forEach(child => {
        child.classList.remove('ml-spread-left', 'ml-spread-right', 'ml-spread-full', 'ml-spread-nonpage');
        child.style.removeProperty('grid-row');
      });
    });

    document.querySelectorAll('.ml-spread-width-unlock').forEach(el => {
      el.classList.remove('ml-spread-width-unlock');
    });
  }

  function applyLayout() {
    if (!isReaderPage() || !settings.enabled) {
      cleanupAllLayouts();
      return;
    }

    if (settings.viewMode === 'book') {
      applyBookMode();
    } else {
      const stage = document.getElementById('ml-book-stage');
      if (stage) stage.remove();
      restoreNativeContainer();
      applyVerticalSpread();
    }
  }

  function scheduleLayout() {
    if (layoutRaf) cancelAnimationFrame(layoutRaf);
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = null;
      applyLayout();
    });
  }

  // =========================================================================
  // 7. НАСТРОЙКИ ВНУТРИ ШТАТНОГО МЕНЮ ЧИТАЛКИ MANGALIB
  // =========================================================================

  function createSettingsBlock(idSuffix = '') {
    const block = document.createElement('div');
    block.id = idSuffix ? `ml-spread-settings-block-${idSuffix}` : 'ml-spread-settings-block';
    block.dataset.mlSpreadSettings = '1';

    block.innerHTML = `
      <div class="ml-ss-title">
        <span>Режим разворота</span>
        <span class="ml-ss-badge">2 стр. · v2</span>
      </div>

      <div class="ml-ss-row">
        <div class="ml-ss-label">
          <span>Показывать по две страницы</span>
        </div>
        <label class="ml-ss-switch">
          <input type="checkbox" data-setting="enabled">
          <span class="ml-ss-slider"></span>
        </label>
      </div>

      <div class="ml-ss-sub-controls">
        <div class="ml-ss-block-col">
          <div class="ml-ss-label">
            <span>Способ отображения</span>
          </div>
          <div class="ml-ss-segmented">
            <button type="button" class="ml-ss-seg-btn" data-mode="book">Книга (листание)</button>
            <button type="button" class="ml-ss-seg-btn" data-mode="vertical">Лента (скролл)</button>
          </div>
        </div>

        <div class="ml-ss-block-col">
          <div class="ml-ss-label">
            <span>Первая страница в развороте</span>
            <span class="ml-ss-sub">Порядок страниц в паре</span>
          </div>
          <div class="ml-ss-segmented">
            <button type="button" class="ml-ss-seg-btn" data-side="right">Справа (2 | 1)</button>
            <button type="button" class="ml-ss-seg-btn" data-side="left">Слева (1 | 2)</button>
          </div>
        </div>

        <div class="ml-ss-book-only">
          <div class="ml-ss-row">
            <div class="ml-ss-label">
              <span>Листать справа налево (манга)</span>
              <span class="ml-ss-sub">Клик слева / ← / A — следующий разворот</span>
            </div>
            <label class="ml-ss-switch">
              <input type="checkbox" data-setting="rtlNav">
              <span class="ml-ss-slider"></span>
            </label>
          </div>

          <div class="ml-ss-row">
            <div class="ml-ss-label">
              <span>Анимация перелистывания книги</span>
              <span class="ml-ss-sub">3D-переворот листа вокруг корешка</span>
            </div>
            <label class="ml-ss-switch">
              <input type="checkbox" data-setting="flipAnimation">
              <span class="ml-ss-slider"></span>
            </label>
          </div>
        </div>

        <div class="ml-ss-row">
          <div class="ml-ss-label">
            <span>Обложка отдельно</span>
            <span class="ml-ss-sub">Сдвиг разворота на 1 стр. (клавиша O)</span>
          </div>
          <label class="ml-ss-switch">
            <input type="checkbox" data-setting="coverAlone">
            <span class="ml-ss-slider"></span>
          </label>
        </div>

        <div class="ml-ss-row">
          <div class="ml-ss-label">
            <span>Широкие страницы отдельно</span>
            <span class="ml-ss-sub">Двойные сканы на всю ширину</span>
          </div>
          <label class="ml-ss-switch">
            <input type="checkbox" data-setting="autoWide">
            <span class="ml-ss-slider"></span>
          </label>
        </div>

        <div class="ml-ss-row">
          <div class="ml-ss-label">
            <span>Вписывать по высоте экрана</span>
            <span class="ml-ss-sub">Чтобы разворот помещался целиком</span>
          </div>
          <label class="ml-ss-switch">
            <input type="checkbox" data-setting="fitHeight">
            <span class="ml-ss-slider"></span>
          </label>
        </div>
      </div>
    `;

    block.querySelectorAll('input[data-setting]').forEach(input => {
      input.addEventListener('change', () => {
        saveSettings({ [input.dataset.setting]: input.checked });
      });
    });

    block.querySelectorAll('button[data-mode]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        saveSettings({ viewMode: btn.dataset.mode });
      });
    });

    block.querySelectorAll('button[data-side]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const side = btn.dataset.side;
        // При переключении «Справа / Слева» удобно сразу подстроить направление листания
        saveSettings({
          firstPageSide: side,
          rtlNav: side === 'right'
        });
      });
    });

    syncBlockUI(block);
    return block;
  }

  function syncBlockUI(block) {
    block.querySelectorAll('input[data-setting]').forEach(input => {
      input.checked = Boolean(settings[input.dataset.setting]);
    });

    block.querySelectorAll('button[data-mode]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.mode === settings.viewMode);
    });

    block.querySelectorAll('button[data-side]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.side === settings.firstPageSide);
    });

    const subGroup = block.querySelector('.ml-ss-sub-controls');
    if (subGroup) {
      subGroup.classList.toggle('ml-ss-disabled-group', !settings.enabled);
    }

    const bookOnly = block.querySelector('.ml-ss-book-only');
    if (bookOnly) {
      bookOnly.style.display = settings.viewMode === 'book' ? '' : 'none';
    }
  }

  function syncAllSettingsUI() {
    document.querySelectorAll('[data-ml-spread-settings="1"]').forEach(syncBlockUI);
  }

  function tryInjectIntoNativeSettings() {
    if (!isReaderPage()) return;
    if (document.getElementById('ml-spread-settings-block')) return;

    const keywords = [
      'Режим чтения',
      'Настройки читалки',
      'Ширина контейнера',
      'Область переключения',
      'Reading mode',
      'Reader settings'
    ];

    const candidates = document.querySelectorAll(
      '[role="dialog"], [class*="modal"], [class*="drawer"], [class*="popup"], [class*="settings"], aside'
    );

    for (const container of candidates) {
      if (container.offsetParent === null) continue;
      const text = container.textContent || '';
      if (!keywords.some(k => text.includes(k))) continue;

      const allNodes = container.querySelectorAll('div, section, label, span, h3, h4, p');
      let anchorSection = null;

      for (const node of allNodes) {
        if (node.children.length > 3) continue;
        const t = (node.textContent || '').trim();
        if (t === 'Режим чтения' || t === 'Reading mode' || t === 'Ширина контейнера') {
          anchorSection = node.parentElement;
          if (anchorSection && anchorSection.parentElement && anchorSection.parentElement !== container) {
            if (anchorSection.textContent.trim() === t) {
              anchorSection = anchorSection.parentElement;
            }
          }
          break;
        }
      }

      const block = createSettingsBlock();
      if (anchorSection && anchorSection.parentElement) {
        anchorSection.insertAdjacentElement('afterend', block);
      } else {
        const body = container.querySelector('[class*="body"], [class*="content"]') || container;
        body.appendChild(block);
      }
      return;
    }
  }

  function openFallbackModal() {
    const existing = document.getElementById('ml-spread-fallback-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'ml-spread-fallback-backdrop';

    const modal = document.createElement('div');
    modal.id = 'ml-spread-fallback-modal';
    modal.innerHTML = `
      <div class="ml-ss-modal-header">
        <span>Настройки разворота MangaLib</span>
        <button type="button" class="ml-ss-modal-close" title="Закрыть">&times;</button>
      </div>
    `;

    const block = createSettingsBlock('modal');
    block.style.margin = '0';
    modal.appendChild(block);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    modal.querySelector('.ml-ss-modal-close').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
  }

  // =========================================================================
  // 8. КЛАВИАТУРА, SPA-ПЕРЕХОДЫ И ЗАПУСК
  // =========================================================================

  function isModalOpen() {
    if (document.getElementById('ml-spread-fallback-backdrop')) return true;
    const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"][class*="open"], [class*="drawer"][class*="open"]');
    return Array.from(dialogs).some(el => el.offsetParent !== null);
  }

  function setupListeners() {
    window.addEventListener('keydown', (e) => {
      if (!isReaderPage() || !settings.enabled) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;

      // Горячая клавиша O — быстрый сдвиг обложки
      if (e.code === 'KeyO') {
        e.preventDefault();
        e.stopImmediatePropagation();
        saveSettings({ coverAlone: !settings.coverAlone });
        showToast(settings.coverAlone ? 'Обложка отдельно: Вкл' : 'Обложка отдельно: Выкл');
        return;
      }

      // Навигация клавишами в режиме 3D-книги
      if (settings.viewMode !== 'book' || !document.getElementById('ml-book-stage')) return;
      if (isModalOpen()) return;

      if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        e.preventDefault();
        e.stopImmediatePropagation();
        stepSpread(settings.rtlNav ? 1 : -1);
      } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        e.preventDefault();
        e.stopImmediatePropagation();
        stepSpread(settings.rtlNav ? -1 : 1);
      } else if (e.code === 'Space') {
        e.preventDefault();
        e.stopImmediatePropagation();
        stepSpread(e.shiftKey ? -1 : 1);
      } else if (e.code === 'Home') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const prev = currentSpreadIndex;
        currentSpreadIndex = 0;
        renderBookSpread(false, prev, -1);
      } else if (e.code === 'End') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const groups = computeSpreadGroups(chapterPages);
        const prev = currentSpreadIndex;
        currentSpreadIndex = Math.max(0, groups.length - 1);
        renderBookSpread(false, prev, 1);
      }
    }, true);

    const onUrlChange = () => {
      if (location.href === currentUrl) return;
      const prevPath = new URL(currentUrl).pathname;
      currentUrl = location.href;
      const newPath = new URL(currentUrl).pathname;

      if (newPath !== prevPath) {
        const expectedKey = parseChapterKeyFromUrl(currentUrl);
        if (expectedKey && expectedKey !== chapterKey) {
          chapterPages = [];
          currentSpreadIndex = 0;
          const stage = document.getElementById('ml-book-stage');
          if (stage) stage.remove();
          restoreNativeContainer();
        }
        scheduleLayout();
      }
    };

    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    ['pushState', 'replaceState'].forEach(method => {
      const orig = pageWin.history[method];
      if (typeof orig === 'function') {
        pageWin.history[method] = function (...args) {
          const ret = orig.apply(this, args);
          onUrlChange();
          return ret;
        };
      }
    });
    window.addEventListener('popstate', onUrlChange);

    const observer = new MutationObserver((mutations) => {
      if (isSyntheticClick) return;
      let needLayout = false;
      let needSettingsCheck = false;

      for (const m of mutations) {
        if (m.target?.closest?.('#ml-book-stage, #ml-spread-settings-block, #ml-spread-fallback-backdrop')) {
          continue;
        }
        if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
          needLayout = true;
          needSettingsCheck = true;
        } else if (m.type === 'attributes' && m.target?.tagName === 'IMG') {
          needLayout = true;
        }
      }

      if (needSettingsCheck) tryInjectIntoNativeSettings();
      if (needLayout) scheduleLayout();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
  }

  function init() {
    injectStyles();

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('⚙ Настройки разворота', openFallbackModal);
      GM_registerMenuCommand('↔ Вкл/Выкл режим разворота', () => {
        saveSettings({ enabled: !settings.enabled });
      });
    }

    setupListeners();
    tryInjectIntoNativeSettings();
    scheduleLayout();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
