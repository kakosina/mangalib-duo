// ==UserScript==
// @name         MangaLib Duo
// @namespace    https://github.com/kakosina/mangalib-duo
// @version      2.9.0
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

  const STORAGE_KEY = 'mangalib_duo_settings_v29';

  const DEFAULT_SETTINGS = {
    enabled: true,           // Двустраничный режим (Alt+D)
    firstPageSide: 'right',  // 'right' (манга: 2 | 1) | 'left' (комикс: 1 | 2)
    rtlNav: true,            // Листать справа налево (клик слева / ← = вперёд)
    flipAnimation: true,     // 3D-анимация перелистывания книги
    coverAlone: false,       // Обложка отдельно (сдвиг парности, Alt+S)
    autoWide: true,          // Широкие сканы целиком на всю ширину
    cleanScreen: true        // Скрывать верхнее и нижнее меню при открытии главы
  };

  function loadSettings() {
    try {
      const raw = typeof GM_getValue === 'function'
        ? GM_getValue(STORAGE_KEY, null)
        : localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch (_) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(patch) {
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

    if (prevEnabled !== settings.enabled) {
      if (!settings.enabled) {
        cleanupDuoStage();
      } else {
        applyCleanScreenState(settings.cleanScreen);
      }
    } else if ('cleanScreen' in patch && isReaderPage() && settings.enabled) {
      applyCleanScreenState(settings.cleanScreen);
    }

    scheduleRender();
  }

  let settings = loadSettings();

  // Состояние текущей главы
  let chapterPages = [];          // [{ index, url, image, fullUrl, width, height }]
  let pagesFromApi = false;       // Загружен ли полный список страниц из API
  let chapterKey = '';            // slug_vol_num
  let cdnOrigin = '';             // Хост картинок (определяется автоматически)
  let fallbackImageServers = [
    'https://img3.imgslib.link',
    'https://img2.mixlib.me',
    'https://img33.imgslib.link'
  ];
  let detectedApiOrigin = '';
  let detectedAuthHeader = '';
  let detectedSiteId = '1';

  let currentSpreadIndex = 0;
  let openAtLastSpread = false;
  let lastSpreadChangeAt = 0;
  let isFlipping = false;
  let flipTimer = null;
  let renderRaf = null;
  let apiFallbackTimer = null;
  let apiFetchInFlightFor = '';
  let currentUrl = location.href;
  let hiddenNativeContainer = null;
  let uiHidden = settings.cleanScreen;
  let touchStartX = null;
  let touchStartY = null;

  // =========================================================================
  // 1. ПЕРЕХВАТ API И НАДЁЖНАЯ ЗАГРУЗКА СПИСКА СТРАНИЦ ГЛАВЫ
  // =========================================================================

  function parseChapterRoute(pathname = location.pathname) {
    const m = pathname.match(/(?:\/[a-z]{2})?(?:\/manga)?\/([^/]+)\/(?:read\/)?v([^/]+)\/c([^/?#]+)/i);
    if (!m) return null;
    return {
      slug: m[1],
      volume: m[2],
      number: m[3],
      key: `${m[1]}_${m[2]}_${m[3]}`
    };
  }

  function isReaderPage(pathname = location.pathname) {
    return Boolean(parseChapterRoute(pathname)) || /\/read\//i.test(pathname);
  }

  function resolveImageUrl(page, serverOverride = '') {
    if (!page) return '';
    if (!serverOverride && page.fullUrl) return page.fullUrl;
    const rawUrl = page.url || '';
    if (!serverOverride && /^https?:\/\//i.test(rawUrl)) return rawUrl;
    if (!serverOverride && rawUrl.startsWith('//')) return 'https:' + rawUrl;

    const host = (serverOverride || cdnOrigin || fallbackImageServers[0] || '').replace(/\/+$/, '');
    if (!host) return '';

    if (rawUrl) {
      if (/^https?:\/\//i.test(rawUrl)) {
        try {
          const u = new URL(rawUrl);
          return host + u.pathname;
        } catch (_) {
          return rawUrl;
        }
      }
      return host + (rawUrl.startsWith('/') ? '' : '/') + rawUrl;
    }

    if (page.image) {
      return host + '/' + page.image.replace(/^\/+/, '');
    }
    return '';
  }

  function extractImageServers(payload) {
    try {
      const servers = payload?.data?.imageServers || payload?.imageServers;
      if (!Array.isArray(servers)) return;
      const urls = servers
        .filter(s => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
        .map(s => s.url.replace(/\/+$/, ''));
      if (urls.length) {
        fallbackImageServers = Array.from(new Set([...urls, ...fallbackImageServers]));
        if (!cdnOrigin) cdnOrigin = urls[0];
      }
    } catch (_) {}
  }

  function extractChapterPages(payload, sourceRoute = null) {
    try {
      const data = payload?.data || payload;
      if (!data) return;

      extractImageServers(payload);

      if (!Array.isArray(data.pages) || data.pages.length === 0) return;
      const valid = data.pages.every(p => p && (typeof p.url === 'string' || typeof p.image === 'string'));
      if (!valid) return;

      const route = sourceRoute || parseChapterRoute();
      const newKey = route
        ? route.key
        : (data.volume != null && data.number != null ? `v${data.volume}_c${data.number}` : String(data.id || Date.now()));

      // Игнорируем случайный ответ от другой главы
      if (route && data.volume != null && data.number != null) {
        if (String(data.volume) !== String(route.volume) || String(data.number) !== String(route.number)) {
          return;
        }
      }

      const isSameChapter = newKey === chapterKey && pagesFromApi && chapterPages.length === data.pages.length;

      chapterKey = newKey;
      pagesFromApi = true;
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
          const pParam = Number(new URLSearchParams(location.search).get('p'));
          if (pParam > 1) {
            const groups = computeSpreadGroups(chapterPages);
            const found = groups.findIndex(g => g.pages.includes(pParam - 1));
            currentSpreadIndex = found >= 0 ? found : 0;
          } else {
            currentSpreadIndex = 0;
          }
        }
        lastSpreadChangeAt = Date.now();
      }

      scheduleRender();
    } catch (_) {}
  }

  function rememberApiContext(reqUrl, headersObj) {
    try {
      if (!reqUrl || !reqUrl.includes('/api/')) return;
      const parsed = new URL(reqUrl, location.origin);
      if (parsed.pathname.startsWith('/api/')) {
        detectedApiOrigin = parsed.origin;
      }
      if (headersObj) {
        const readHeader = (name) => {
          if (headersObj instanceof Headers) return headersObj.get(name);
          if (Array.isArray(headersObj)) {
            const found = headersObj.find(([k]) => String(k).toLowerCase() === name);
            return found ? found[1] : '';
          }
          const key = Object.keys(headersObj).find(k => k.toLowerCase() === name);
          return key ? headersObj[key] : '';
        };
        const auth = readHeader('authorization');
        const siteId = readHeader('site-id');
        if (auth) detectedAuthHeader = auth;
        if (siteId) detectedSiteId = String(siteId);
      }
    } catch (_) {}
  }

  function hookNetwork() {
    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    if (typeof pageWin.fetch === 'function' && !pageWin.__mlDuoFetchHooked) {
      pageWin.__mlDuoFetchHooked = true;
      const origFetch = pageWin.fetch.bind(pageWin);
      pageWin.fetch = async function (...args) {
        const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        const reqHeaders = args[1]?.headers || args[0]?.headers;
        rememberApiContext(reqUrl, reqHeaders);

        const response = await origFetch(...args);
        try {
          if (reqUrl.includes('/chapter') || reqUrl.includes('/constants') || reqUrl.includes('/manga/')) {
            response.clone().json().then(json => extractChapterPages(json)).catch(() => {});
          }
        } catch (_) {}
        return response;
      };
    }

    const XHRProto = pageWin.XMLHttpRequest?.prototype;
    if (XHRProto && !XHRProto.__mlDuoXhrHooked) {
      XHRProto.__mlDuoXhrHooked = true;
      const origOpen = XHRProto.open;
      const origSetHeader = XHRProto.setRequestHeader;
      const origSend = XHRProto.send;

      XHRProto.open = function (method, url, ...rest) {
        this._mlDuoUrl = typeof url === 'string' ? url : '';
        this._mlDuoHeaders = {};
        return origOpen.call(this, method, url, ...rest);
      };

      XHRProto.setRequestHeader = function (name, value) {
        if (this._mlDuoHeaders && name) {
          this._mlDuoHeaders[String(name).toLowerCase()] = value;
        }
        return origSetHeader.call(this, name, value);
      };

      XHRProto.send = function (...args) {
        rememberApiContext(this._mlDuoUrl, this._mlDuoHeaders);
        this.addEventListener('load', function () {
          try {
            const u = this._mlDuoUrl || '';
            if (u.includes('/chapter') || u.includes('/constants') || u.includes('/manga/')) {
              if (this.responseText && this.responseText.trim().startsWith('{')) {
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

  // Прямой резервный запрос к API главы, если SPA взял главу из кэша или скрипт подключился позже
  async function fetchChapterFromApiFallback() {
    const route = parseChapterRoute();
    if (!route) return;
    if (pagesFromApi && chapterKey === route.key && chapterPages.length > 0) return;
    if (apiFetchInFlightFor === route.key) return;
    apiFetchInFlightFor = route.key;

    const search = new URLSearchParams(location.search);
    const branchId = search.get('bid') || search.get('branch_id') || '';
    const qs = new URLSearchParams({ number: route.number, volume: route.volume });
    if (branchId) qs.set('branch_id', branchId);

    const apiHosts = Array.from(new Set([
      detectedApiOrigin,
      'https://api.cdnlibs.org',
      location.origin
    ].filter(Boolean)));

    const headers = { Accept: 'application/json', 'Site-Id': detectedSiteId || '1' };
    if (detectedAuthHeader) headers.Authorization = detectedAuthHeader;

    for (const host of apiHosts) {
      try {
        const url = `${host}/api/manga/${encodeURIComponent(route.slug)}/chapter?${qs.toString()}`;
        const res = await fetch(url, { headers, credentials: 'omit' });
        if (!res.ok) continue;
        const json = await res.json();
        if (json?.data?.pages?.length) {
          extractChapterPages(json, route);
          return;
        }
      } catch (_) {}
    }
  }

  // =========================================================================
  // 2. СТИЛИ (НАТИВНОЕ МЕНЮ + ГОРИЗОНТАЛЬНАЯ 3D-КНИГА + ЧИСТЫЙ ЭКРАН)
  // =========================================================================

  const STYLES = `
    /* Блокируем вертикальную полосу прокрутки в активном режиме разворота */
    html.ml-duo-active,
    html.ml-duo-active body {
      overflow: hidden !important;
      height: 100% !important;
      overscroll-behavior: none !important;
    }

    /* Чистый экран: скрываем родные верхнюю и нижнюю панели читалки */
    html.ml-duo-ui-hidden [data-ml-duo-chrome="top"] {
      opacity: 0 !important;
      pointer-events: none !important;
      transform: translateY(-100%) !important;
      transition: opacity 0.18s ease, transform 0.18s ease !important;
    }

    html.ml-duo-ui-hidden [data-ml-duo-chrome="bottom"] {
      opacity: 0 !important;
      pointer-events: none !important;
      transform: translateY(100%) !important;
      transition: opacity 0.18s ease, transform 0.18s ease !important;
    }

    [data-ml-duo-chrome="top"],
    [data-ml-duo-chrome="bottom"] {
      transition: opacity 0.18s ease, transform 0.18s ease !important;
    }

    /* Скрытие штатной ленты/страницы читалки */
    .ml-duo-native-probe {
      position: fixed !important;
      inset: 0 !important;
      opacity: 0 !important;
      pointer-events: none !important;
      z-index: -1 !important;
      overflow: hidden !important;
    }

    .ml-duo-native-hidden {
      display: none !important;
    }

    /* --- ГОРИЗОНТАЛЬНАЯ СЦЕНА РАЗВОРОТА (2 СТРАНИЦЫ, 100vh) --- */
    #ml-duo-stage {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
      -webkit-user-select: none;
      overflow: hidden;
      background: transparent;
      box-sizing: border-box;
    }

    .ml-duo-viewport {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      perspective: 2400px;
      perspective-origin: 50% 50%;
    }

    .ml-duo-spread {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      transform-style: preserve-3d;
    }

    .ml-duo-slot {
      position: relative;
      width: 50%;
      height: 100%;
      display: flex;
      align-items: center;
      min-width: 0;
      box-sizing: border-box;
    }

    .ml-duo-slot.is-left {
      justify-content: flex-end;
    }

    .ml-duo-slot.is-right {
      justify-content: flex-start;
    }

    .ml-duo-solo-slot {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .ml-duo-sheet {
      position: relative;
      display: inline-flex;
      max-width: 100%;
      max-height: 100%;
      overflow: hidden;
    }

    .ml-duo-sheet > img {
      display: block;
      max-height: 100vh;
      width: auto;
      height: auto;
      object-fit: contain;
      pointer-events: none;
    }

    .ml-duo-slot .ml-duo-sheet > img {
      max-width: 50vw;
    }

    .ml-duo-solo-slot .ml-duo-sheet > img {
      max-width: 100vw;
    }

    /* Тень у корешка (включена только при активной 3D-анимации книги) */
    #ml-duo-stage.ml-book-fx .ml-duo-sheet.is-left-page::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(
        to left,
        rgba(0, 0, 0, 0.28) 0%,
        rgba(0, 0, 0, 0.09) 10px,
        transparent 34px
      );
    }

    #ml-duo-stage.ml-book-fx .ml-duo-sheet.is-right-page::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(
        to right,
        rgba(0, 0, 0, 0.28) 0%,
        rgba(0, 0, 0, 0.09) 10px,
        transparent 34px
      );
    }

    /* --- 3D ПЕРЕЛИСТЫВАНИЕ КНИГИ ВБОК --- */
    .ml-duo-flipper {
      position: absolute;
      top: 0;
      height: 100%;
      width: 50%;
      transform-style: preserve-3d;
      z-index: 6;
      pointer-events: none;
      will-change: transform;
    }

    .ml-duo-flipper.turn-l2r {
      left: 0;
      transform-origin: right center;
      animation: mlDuoFlipL2R 440ms cubic-bezier(0.32, 0.08, 0.24, 1) forwards;
    }

    .ml-duo-flipper.turn-r2l {
      left: 50%;
      transform-origin: left center;
      animation: mlDuoFlipR2L 440ms cubic-bezier(0.32, 0.08, 0.24, 1) forwards;
    }

    .ml-duo-face {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
    }

    .ml-duo-flipper.turn-l2r .ml-duo-face.is-front { justify-content: flex-end; }
    .ml-duo-flipper.turn-l2r .ml-duo-face.is-back  { justify-content: flex-start; transform: rotateY(180deg); }
    .ml-duo-flipper.turn-r2l .ml-duo-face.is-front { justify-content: flex-start; }
    .ml-duo-flipper.turn-r2l .ml-duo-face.is-back  { justify-content: flex-end; transform: rotateY(180deg); }

    .ml-duo-shade {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: #000;
      opacity: 0;
    }

    .ml-duo-face.is-front .ml-duo-shade { animation: mlDuoShadeFront 440ms ease forwards; }
    .ml-duo-face.is-back .ml-duo-shade  { animation: mlDuoShadeBack 440ms ease forwards; }

    .ml-duo-under {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: #000;
      opacity: 0;
      z-index: 2;
    }

    .ml-duo-under.is-revealing { animation: mlDuoUnderReveal 440ms ease-out forwards; }
    .ml-duo-under.is-covering  { animation: mlDuoUnderCover 440ms ease-in forwards; }

    /* Боковой сдвиг (если 3D выключен или для широких одиночных сканов) */
    .ml-duo-slide-l2r {
      animation: mlDuoSlideL2R 220ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }

    .ml-duo-slide-r2l {
      animation: mlDuoSlideR2L 220ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }

    @keyframes mlDuoFlipL2R {
      0%   { transform: rotateY(0deg); }
      100% { transform: rotateY(180deg); }
    }

    @keyframes mlDuoFlipR2L {
      0%   { transform: rotateY(0deg); }
      100% { transform: rotateY(-180deg); }
    }

    @keyframes mlDuoShadeFront {
      0%   { opacity: 0; }
      50%  { opacity: 0.36; }
      100% { opacity: 0.5; }
    }

    @keyframes mlDuoShadeBack {
      0%   { opacity: 0.5; }
      50%  { opacity: 0.32; }
      100% { opacity: 0; }
    }

    @keyframes mlDuoUnderReveal {
      0%   { opacity: 0.42; }
      100% { opacity: 0; }
    }

    @keyframes mlDuoUnderCover {
      0%   { opacity: 0; }
      100% { opacity: 0.38; }
    }

    @keyframes mlDuoSlideL2R {
      0%   { opacity: 0.35; transform: translateX(-32px); }
      100% { opacity: 1; transform: translateX(0); }
    }

    @keyframes mlDuoSlideR2L {
      0%   { opacity: 0.35; transform: translateX(32px); }
      100% { opacity: 1; transform: translateX(0); }
    }

    /* Невидимые зоны клика (лево / центр / право) */
    .ml-duo-zones {
      position: absolute;
      inset: 0;
      display: grid;
      grid-template-columns: 35% 30% 35%;
      z-index: 10;
    }

    .ml-duo-zone-left   { cursor: pointer; }
    .ml-duo-zone-center { cursor: pointer; }
    .ml-duo-zone-right  { cursor: pointer; }

    /* --- НАТИВНАЯ СЕКЦИЯ НАСТРОЕК ВНУТРИ ПАНЕЛИ MANGALIB --- */
    #ml-duo-settings-section,
    [data-ml-duo-settings="1"] {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid rgba(128, 128, 128, 0.22);
      font-family: inherit;
      font-size: 14px;
      color: inherit;
    }

    .ml-duo-sec-title {
      font-size: 13px;
      font-weight: 600;
      opacity: 0.72;
      margin-bottom: 8px;
      letter-spacing: 0.01em;
    }

    .ml-duo-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 34px;
      padding: 4px 0;
    }

    .ml-duo-col {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 6px 0;
    }

    .ml-duo-label {
      font-size: 14px;
      line-height: 1.3;
    }

    .ml-duo-hint {
      font-size: 11px;
      opacity: 0.55;
      margin-left: 6px;
    }

    .ml-duo-switch {
      position: relative;
      display: inline-block;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
      cursor: pointer;
    }

    .ml-duo-switch input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }

    .ml-duo-slider {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: rgba(128, 128, 128, 0.35);
      transition: background 0.18s ease;
    }

    .ml-duo-slider::before {
      content: "";
      position: absolute;
      width: 14px;
      height: 14px;
      left: 3px;
      top: 3px;
      border-radius: 50%;
      background: #fff;
      transition: transform 0.18s ease;
    }

    .ml-duo-switch input:checked + .ml-duo-slider {
      background: #f59e0b;
    }

    .ml-duo-switch input:checked + .ml-duo-slider::before {
      transform: translateX(16px);
    }

    .ml-duo-seg {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      padding: 2px;
      border-radius: 6px;
      background: rgba(128, 128, 128, 0.14);
    }

    .ml-duo-seg-btn {
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 13px;
      padding: 5px 8px;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.78;
      transition: background 0.15s ease, opacity 0.15s ease;
    }

    .ml-duo-seg-btn.is-active {
      background: rgba(128, 128, 128, 0.28);
      opacity: 1;
      font-weight: 600;
    }

    .ml-duo-disabled {
      opacity: 0.42;
      pointer-events: none;
    }

    /* Резервное окно настроек (если открыть через меню Tampermonkey/Violentmonkey) */
    #ml-duo-fallback-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }

    #ml-duo-fallback-modal {
      width: 100%;
      max-width: 360px;
      background: #1c1c1f;
      color: #f4f4f5;
      border-radius: 10px;
      padding: 16px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .ml-duo-modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      font-size: 15px;
    }

    .ml-duo-modal-close {
      background: transparent;
      border: none;
      color: inherit;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      opacity: 0.7;
    }

    .ml-duo-modal-close:hover { opacity: 1; }
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
  // 3. ЧИСТЫЙ ЭКРАН И ПОЛНОЭКРАННЫЙ РЕЖИМ
  // =========================================================================

  function isFullscreen() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    if (isFullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) Promise.resolve(exit.call(document)).catch(() => {});
    } else {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) Promise.resolve(req.call(el)).catch(() => {});
    }
  }

  function tagNativeReaderChrome() {
    if (!isReaderPage()) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Проверяем header и все fixed/sticky панели наверху и внизу экрана (кроме модалок)
    const candidates = document.querySelectorAll('header, footer, nav, body > div div');
    for (const el of candidates) {
      if (el.id === 'ml-duo-stage' || el.closest('#ml-duo-stage, #ml-duo-fallback-backdrop, [role="dialog"], [class*="modal"], [class*="drawer"], [class*="popup"], [class*="popover"]')) {
        continue;
      }
      if (el.dataset.mlDuoChrome) continue;

      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.45 || rect.height < 28 || rect.height > 140) continue;

      if (rect.top <= 12) {
        el.dataset.mlDuoChrome = 'top';
      } else if (rect.bottom >= vh - 12) {
        el.dataset.mlDuoChrome = 'bottom';
      }
    }
  }

  function applyCleanScreenState(hidden) {
    uiHidden = Boolean(hidden);
    if (!isReaderPage() || !settings.enabled) {
      document.documentElement.classList.remove('ml-duo-ui-hidden');
      return;
    }
    tagNativeReaderChrome();
    document.documentElement.classList.toggle('ml-duo-ui-hidden', uiHidden);
  }

  function toggleReaderChrome() {
    applyCleanScreenState(!uiHidden);
  }

  // =========================================================================
  // 4. ПОИСК КАРТИНОК И РАЗБИЕНИЕ НА РАЗВОРОТЫ
  // =========================================================================

  function isLikelyMangaImage(img) {
    if (!img || img.closest('#ml-duo-stage, #ml-duo-settings-section, #ml-duo-fallback-backdrop')) return false;
    if (img.closest('header, nav, footer, [role="dialog"]')) return false;
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
    if (!src) return false;
    if (/avatar|logo|icon|emoji|sticker|badge/i.test(src)) return false;
    if (img.closest('[data-p], [data-page], [data-media-id]')) return true;
    if (/\/manga\/|imgslib|cdnlibs|mixlib|mangalib/i.test(src)) return true;
    return img.naturalWidth >= 300 || img.clientWidth >= 250;
  }

  function getNativeReaderImages() {
    const root = document.querySelector('main') || document.body;
    if (!root) return [];
    return Array.from(root.querySelectorAll('img')).filter(isLikelyMangaImage);
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

  function detectCdnAndDomFallback() {
    const nativeImgs = getNativeReaderImages();

    for (const img of nativeImgs) {
      const src = img.currentSrc || img.src || '';
      if (!/^https?:\/\//i.test(src)) continue;

      if (!cdnOrigin) {
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
        if (!cdnOrigin && /imgslib|mixlib|cdnlibs|\/manga\//i.test(src)) {
          try { cdnOrigin = new URL(src).origin; } catch (_) {}
        }
      }
    }

    // Если API ещё не ответил, но в DOM уже есть страницы (например, в вертикальной читалке)
    if (!pagesFromApi && nativeImgs.length >= 2) {
      const route = parseChapterRoute();
      chapterKey = route ? route.key : 'dom';
      chapterPages = nativeImgs.map((img, idx) => ({
        index: idx,
        url: img.currentSrc || img.src || img.getAttribute('data-src') || '',
        image: '',
        fullUrl: img.currentSrc || img.src || img.getAttribute('data-src') || '',
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0
      })).filter(p => Boolean(p.fullUrl));
    }

    return nativeImgs;
  }

  function isWidePage(meta) {
    if (!settings.autoWide || !meta) return false;
    return meta.width > 0 && meta.height > 0 && meta.width > meta.height * 1.15;
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
        groups.push({ pages: [i], solo: true });
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

  function mapGroupToSlots(group) {
    if (!group) return { left: null, right: null, solo: null };
    if (group.solo) {
      return { left: null, right: null, solo: chapterPages[group.pages[0]] || null };
    }
    const p1 = chapterPages[group.pages[0]] || null;
    const p2 = chapterPages[group.pages[1]] || null;
    if (settings.firstPageSide === 'right') {
      return { left: p2, right: p1, solo: null };
    }
    return { left: p1, right: p2, solo: null };
  }

  // =========================================================================
  // 5. ОТРИСОВКА РАЗВОРОТА, 3D-ПЕРЕЛИСТЫВАНИЕ И ПЕРЕХОД ПО ГЛАВАМ
  // =========================================================================

  function createPageSheet(pageMeta, sideClass) {
    if (!pageMeta) return null;
    const url = resolveImageUrl(pageMeta);
    if (!url) return null;

    const sheet = document.createElement('div');
    sheet.className = `ml-duo-sheet ${sideClass}`;

    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.draggable = false;

    let retryIdx = 0;
    img.addEventListener('error', () => {
      if (retryIdx < fallbackImageServers.length) {
        const nextServer = fallbackImageServers[retryIdx++];
        const altUrl = resolveImageUrl(pageMeta, nextServer);
        if (altUrl && altUrl !== img.src) {
          cdnOrigin = nextServer;
          img.src = altUrl;
        }
      }
    });

    img.addEventListener('load', () => {
      if (!pageMeta.width || !pageMeta.height) {
        const wasWide = isWidePage(pageMeta);
        pageMeta.width = img.naturalWidth;
        pageMeta.height = img.naturalHeight;
        if (settings.autoWide && !wasWide && isWidePage(pageMeta)) {
          renderCurrentSpread(false);
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

  function ensureStage() {
    let stage = document.getElementById('ml-duo-stage');
    if (stage) return stage;

    stage = document.createElement('div');
    stage.id = 'ml-duo-stage';
    stage.innerHTML = `
      <div class="ml-duo-viewport">
        <div class="ml-duo-spread"></div>
      </div>
      <div class="ml-duo-zones">
        <div class="ml-duo-zone-left"></div>
        <div class="ml-duo-zone-center"></div>
        <div class="ml-duo-zone-right"></div>
      </div>
    `;

    // Изолируем клики от самой читалки MangaLib, чтобы она не перехватывала их под смену главы
    const stopAll = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    stage.querySelector('.ml-duo-zone-left').addEventListener('click', (e) => {
      stopAll(e);
      stepSpread(settings.rtlNav ? 1 : -1);
    });

    stage.querySelector('.ml-duo-zone-right').addEventListener('click', (e) => {
      stopAll(e);
      stepSpread(settings.rtlNav ? -1 : 1);
    });

    stage.querySelector('.ml-duo-zone-center').addEventListener('click', (e) => {
      stopAll(e);
      toggleReaderChrome();
    });

    // Свайпы влево/вправо на сенсорных экранах
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
        const swipedRight = dx > 0;
        // В манге (RTL) свайп вправо переворачивает левую страницу вперёд; в комиксе — свайп влево вперёд
        stepSpread(settings.rtlNav ? (swipedRight ? 1 : -1) : (swipedRight ? -1 : 1));
      }
    }, { passive: true });

    document.body.appendChild(stage);
    return stage;
  }

  function renderStaticSpread(spreadEl, slots, slideClass = '') {
    spreadEl.innerHTML = '';

    if (slots.solo) {
      const wrap = document.createElement('div');
      wrap.className = `ml-duo-solo-slot ${slideClass}`.trim();
      const sheet = createPageSheet(slots.solo, 'is-solo-page');
      if (sheet) wrap.appendChild(sheet);
      spreadEl.appendChild(wrap);
      return;
    }

    const leftSlot = document.createElement('div');
    leftSlot.className = 'ml-duo-slot is-left';
    const leftSheet = createPageSheet(slots.left, 'is-left-page');
    if (leftSheet) leftSlot.appendChild(leftSheet);

    const rightSlot = document.createElement('div');
    rightSlot.className = 'ml-duo-slot is-right';
    const rightSheet = createPageSheet(slots.right, 'is-right-page');
    if (rightSheet) rightSlot.appendChild(rightSheet);

    spreadEl.appendChild(leftSlot);
    spreadEl.appendChild(rightSlot);

    if (slideClass) {
      spreadEl.classList.remove('ml-duo-slide-l2r', 'ml-duo-slide-r2l');
      void spreadEl.offsetWidth;
      spreadEl.classList.add(slideClass);
    }
  }

  function animateBookFlip(spreadEl, oldSlots, newSlots, turnDirection, onDone) {
    spreadEl.classList.remove('ml-duo-slide-l2r', 'ml-duo-slide-r2l');
    spreadEl.innerHTML = '';

    // Базовые страницы под переворачиваемым листом
    const leftSlot = document.createElement('div');
    leftSlot.className = 'ml-duo-slot is-left';
    const baseLeft = createPageSheet(turnDirection === 'l2r' ? newSlots.left : oldSlots.left, 'is-left-page');
    if (baseLeft) {
      const under = document.createElement('div');
      under.className = `ml-duo-under ${turnDirection === 'l2r' ? 'is-revealing' : 'is-covering'}`;
      baseLeft.appendChild(under);
      leftSlot.appendChild(baseLeft);
    }

    const rightSlot = document.createElement('div');
    rightSlot.className = 'ml-duo-slot is-right';
    const baseRight = createPageSheet(turnDirection === 'l2r' ? oldSlots.right : newSlots.right, 'is-right-page');
    if (baseRight) {
      const under = document.createElement('div');
      under.className = `ml-duo-under ${turnDirection === 'l2r' ? 'is-covering' : 'is-revealing'}`;
      baseRight.appendChild(under);
      rightSlot.appendChild(baseRight);
    }

    // Переворачиваемый 3D-лист
    const flipper = document.createElement('div');
    flipper.className = `ml-duo-flipper ${turnDirection === 'l2r' ? 'turn-l2r' : 'turn-r2l'}`;

    const front = document.createElement('div');
    front.className = 'ml-duo-face is-front';
    const frontSheet = createPageSheet(
      turnDirection === 'l2r' ? oldSlots.left : oldSlots.right,
      turnDirection === 'l2r' ? 'is-left-page' : 'is-right-page'
    );
    if (frontSheet) {
      const shade = document.createElement('div');
      shade.className = 'ml-duo-shade';
      frontSheet.appendChild(shade);
      front.appendChild(frontSheet);
    }

    const back = document.createElement('div');
    back.className = 'ml-duo-face is-back';
    const backSheet = createPageSheet(
      turnDirection === 'l2r' ? newSlots.right : newSlots.left,
      turnDirection === 'l2r' ? 'is-right-page' : 'is-left-page'
    );
    if (backSheet) {
      const shade = document.createElement('div');
      shade.className = 'ml-duo-shade';
      backSheet.appendChild(shade);
      back.appendChild(backSheet);
    }

    flipper.appendChild(front);
    flipper.appendChild(back);

    spreadEl.appendChild(leftSlot);
    spreadEl.appendChild(rightSlot);
    spreadEl.appendChild(flipper);

    isFlipping = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(flipTimer);
      isFlipping = false;
      onDone();
    };

    flipper.addEventListener('animationend', (e) => {
      if (e.target === flipper) finish();
    }, { once: true });

    flipTimer = setTimeout(finish, 500);
  }

  function renderCurrentSpread(animate = false, prevIndex = currentSpreadIndex, stepDir = 1) {
    const stage = document.getElementById('ml-duo-stage');
    if (!stage || !chapterPages.length) return;

    const groups = computeSpreadGroups(chapterPages);
    if (!groups.length) return;

    currentSpreadIndex = Math.max(0, Math.min(currentSpreadIndex, groups.length - 1));
    stage.classList.toggle('ml-book-fx', settings.flipAnimation);

    const spreadEl = stage.querySelector('.ml-duo-spread');
    const newGroup = groups[currentSpreadIndex];
    const oldGroup = groups[prevIndex];
    const newSlots = mapGroupToSlots(newGroup);
    const oldSlots = mapGroupToSlots(oldGroup);

    // Физическое направление перекидывания листа вбок:
    // В манге (firstPageSide === 'right'): шаг вперёд (+1) перекидывает лист слева направо (l2r)
    // В комиксе (firstPageSide === 'left'): шаг вперёд (+1) перекидывает лист справа налево (r2l)
    const isForward = stepDir > 0;
    const turnDirection = (settings.firstPageSide === 'right')
      ? (isForward ? 'l2r' : 'r2l')
      : (isForward ? 'r2l' : 'l2r');

    if (animate && oldGroup && prevIndex !== currentSpreadIndex) {
      if (settings.flipAnimation && !oldGroup.solo && !newGroup.solo) {
        animateBookFlip(spreadEl, oldSlots, newSlots, turnDirection, () => {
          renderStaticSpread(spreadEl, newSlots);
        });
      } else {
        renderStaticSpread(spreadEl, newSlots, turnDirection === 'l2r' ? 'ml-duo-slide-l2r' : 'ml-duo-slide-r2l');
      }
    } else {
      renderStaticSpread(spreadEl, newSlots);
    }

    // Обновляем ?p= в адресной строке без перезагрузки (чтобы позиция сохранялась)
    try {
      const firstPageNum = newGroup.pages[0] + 1;
      const u = new URL(location.href);
      if (u.searchParams.get('p') !== String(firstPageNum)) {
        u.searchParams.set('p', String(firstPageNum));
        const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        pageWin.history.replaceState(pageWin.history.state, '', u.toString());
        currentUrl = u.toString();
      }
    } catch (_) {}

    // Предзагрузка соседних разворотов
    preloadSpread(groups, currentSpreadIndex + 1);
    preloadSpread(groups, currentSpreadIndex + 2);
    preloadSpread(groups, currentSpreadIndex - 1);
  }

  function stepSpread(delta) {
    if (!chapterPages.length) {
      fetchChapterFromApiFallback();
      return;
    }

    const groups = computeSpreadGroups(chapterPages);
    if (!groups.length) return;

    if (isFlipping) {
      clearTimeout(flipTimer);
      isFlipping = false;
    }

    const nextIdx = currentSpreadIndex + delta;

    if (nextIdx >= groups.length || nextIdx < 0) {
      // Защита от ложного перескока на другую главу, если список страниц ещё не прогружен полностью
      if (!pagesFromApi && chapterPages.length < 2) {
        fetchChapterFromApiFallback();
        return;
      }
      // Защита от случайного двойного клика сразу после попадания на крайний разворот
      if (Date.now() - lastSpreadChangeAt < 350) return;

      goToAdjacentChapter(nextIdx >= groups.length ? 1 : -1);
      return;
    }

    const prevIdx = currentSpreadIndex;
    currentSpreadIndex = nextIdx;
    lastSpreadChangeAt = Date.now();
    renderCurrentSpread(true, prevIdx, delta);
  }

  function compareChapterOrder(a, b) {
    const va = parseFloat(a.volume) || 0;
    const vb = parseFloat(b.volume) || 0;
    if (va !== vb) return va - vb;
    const na = parseFloat(a.number) || 0;
    const nb = parseFloat(b.number) || 0;
    return na - nb;
  }

  function goToAdjacentChapter(direction) {
    const curRoute = parseChapterRoute();
    const links = Array.from(document.querySelectorAll('a[href]')).filter(a => {
      if (a.closest('#ml-duo-stage, #ml-duo-settings-section, #ml-duo-fallback-backdrop')) return false;
      try {
        const u = new URL(a.href, location.origin);
        if (u.pathname === location.pathname) return false;
        const r = parseChapterRoute(u.pathname);
        if (!r) return false;
        if (curRoute && r.slug !== curRoute.slug) return false;
        return true;
      } catch (_) {
        return false;
      }
    });

    let target = null;

    // 1. Сначала ищем по явному тексту/подсказке кнопки
    const rx = direction > 0 ? /следующ|next|впер[её]д/i : /предыдущ|prev|назад/i;
    target = links.find(a => rx.test(`${a.textContent || ''} ${a.title || ''} ${a.getAttribute('aria-label') || ''}`));

    // 2. Затем сравниваем реальные номера глав (чтобы не нажать назад вместо вперёд)
    if (!target && curRoute) {
      const sorted = links
        .map(a => ({ a, route: parseChapterRoute(new URL(a.href, location.origin).pathname) }))
        .filter(item => item.route && (direction > 0
          ? compareChapterOrder(item.route, curRoute) > 0
          : compareChapterOrder(item.route, curRoute) < 0))
        .sort((x, y) => direction > 0
          ? compareChapterOrder(x.route, y.route)
          : compareChapterOrder(y.route, x.route));

      if (sorted.length) {
        target = sorted[0].a;
      }
    }

    if (target) {
      openAtLastSpread = direction < 0;
      lastSpreadChangeAt = Date.now();
      target.click();
    }
  }

  function restoreNativeContainer() {
    if (hiddenNativeContainer) {
      hiddenNativeContainer.classList.remove('ml-duo-native-probe', 'ml-duo-native-hidden');
      hiddenNativeContainer = null;
    }
  }

  function cleanupDuoStage() {
    clearTimeout(flipTimer);
    clearTimeout(apiFallbackTimer);
    isFlipping = false;

    const stage = document.getElementById('ml-duo-stage');
    if (stage) stage.remove();

    restoreNativeContainer();
    document.documentElement.classList.remove('ml-duo-active', 'ml-duo-ui-hidden');
  }

  function getLayoutSig() {
    return `${chapterKey}|${chapterPages.length}|${settings.firstPageSide}|${settings.rtlNav}|${settings.flipAnimation}|${settings.coverAlone}|${settings.autoWide}`;
  }

  function applyDuoLayout() {
    if (!isReaderPage() || !settings.enabled) {
      cleanupDuoStage();
      return;
    }

    document.documentElement.classList.add('ml-duo-active');
    applyCleanScreenState(uiHidden);

    const nativeImgs = detectCdnAndDomFallback();
    const nativeContainer = findNativeContainer(nativeImgs);

    if (nativeContainer && nativeContainer !== hiddenNativeContainer) {
      restoreNativeContainer();
      hiddenNativeContainer = nativeContainer;
    }

    // Если API ещё не пойман — запускаем резервный запрос к API главы
    if (!pagesFromApi) {
      clearTimeout(apiFallbackTimer);
      apiFallbackTimer = setTimeout(fetchChapterFromApiFallback, 250);
    }

    if (!chapterPages.length) {
      if (hiddenNativeContainer) {
        hiddenNativeContainer.classList.add('ml-duo-native-probe');
      }
      return;
    }

    if (hiddenNativeContainer) {
      if (cdnOrigin) {
        hiddenNativeContainer.classList.remove('ml-duo-native-probe');
        hiddenNativeContainer.classList.add('ml-duo-native-hidden');
      } else {
        hiddenNativeContainer.classList.add('ml-duo-native-probe');
      }
    }

    const stage = ensureStage();
    const sig = getLayoutSig();
    if (stage.dataset.sig !== sig || !stage.querySelector('.ml-duo-spread')?.children.length) {
      stage.dataset.sig = sig;
      renderCurrentSpread(false);
    }
  }

  function scheduleRender() {
    if (renderRaf) cancelAnimationFrame(renderRaf);
    renderRaf = requestAnimationFrame(() => {
      renderRaf = null;
      applyDuoLayout();
    });
  }

  // =========================================================================
  // 6. НАТИВНЫЙ БЛОК НАСТРОЕК В РОДНОМ МЕНЮ MANGALIB
  // =========================================================================

  function createSettingsSection(suffix = '') {
    const sec = document.createElement('div');
    sec.id = suffix ? `ml-duo-settings-section-${suffix}` : 'ml-duo-settings-section';
    sec.dataset.mlDuoSettings = '1';

    sec.innerHTML = `
      <div class="ml-duo-sec-title">Двустраничный режим (Duo)</div>

      <div class="ml-duo-row">
        <span class="ml-duo-label">Разворот (2 страницы)<span class="ml-duo-hint">Alt+D</span></span>
        <label class="ml-duo-switch">
          <input type="checkbox" data-setting="enabled">
          <span class="ml-duo-slider"></span>
        </label>
      </div>

      <div class="ml-duo-sub">
        <div class="ml-duo-col">
          <span class="ml-duo-label">Первая страница</span>
          <div class="ml-duo-seg">
            <button type="button" class="ml-duo-seg-btn" data-side="right">Справа (манга)</button>
            <button type="button" class="ml-duo-seg-btn" data-side="left">Слева (комикс)</button>
          </div>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">Листать справа налево</span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-setting="rtlNav">
            <span class="ml-duo-slider"></span>
          </label>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">Анимация книги (3D)</span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-setting="flipAnimation">
            <span class="ml-duo-slider"></span>
          </label>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">Обложка отдельно<span class="ml-duo-hint">Alt+S</span></span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-setting="coverAlone">
            <span class="ml-duo-slider"></span>
          </label>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">Широкие сканы целиком</span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-setting="autoWide">
            <span class="ml-duo-slider"></span>
          </label>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">Скрывать меню при открытии</span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-setting="cleanScreen">
            <span class="ml-duo-slider"></span>
          </label>
        </div>

        <div class="ml-duo-row">
          <span class="ml-duo-label">На весь экран<span class="ml-duo-hint">F</span></span>
          <label class="ml-duo-switch">
            <input type="checkbox" data-action="fullscreen">
            <span class="ml-duo-slider"></span>
          </label>
        </div>
      </div>
    `;

    sec.querySelectorAll('input[data-setting]').forEach(input => {
      input.addEventListener('change', () => {
        saveSettings({ [input.dataset.setting]: input.checked });
      });
    });

    const fsInput = sec.querySelector('input[data-action="fullscreen"]');
    if (fsInput) {
      fsInput.addEventListener('change', () => {
        toggleFullscreen();
      });
    }

    sec.querySelectorAll('button[data-side]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const side = btn.dataset.side;
        saveSettings({
          firstPageSide: side,
          rtlNav: side === 'right'
        });
      });
    });

    syncSectionUI(sec);
    return sec;
  }

  function syncSectionUI(sec) {
    sec.querySelectorAll('input[data-setting]').forEach(input => {
      input.checked = Boolean(settings[input.dataset.setting]);
    });

    const fsInput = sec.querySelector('input[data-action="fullscreen"]');
    if (fsInput) fsInput.checked = isFullscreen();

    sec.querySelectorAll('button[data-side]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.side === settings.firstPageSide);
    });

    const sub = sec.querySelector('.ml-duo-sub');
    if (sub) sub.classList.toggle('ml-duo-disabled', !settings.enabled);
  }

  function syncAllSettingsUI() {
    document.querySelectorAll('[data-ml-duo-settings="1"]').forEach(syncSectionUI);
  }

  function tryInjectIntoNativeSettings() {
    if (!isReaderPage()) return;
    if (document.getElementById('ml-duo-settings-section')) return;

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
      let anchor = null;

      for (const node of allNodes) {
        if (node.children.length > 3) continue;
        const t = (node.textContent || '').trim();
        if (t === 'Режим чтения' || t === 'Reading mode' || t === 'Ширина контейнера') {
          anchor = node.parentElement;
          if (anchor && anchor.parentElement && anchor.parentElement !== container && anchor.textContent.trim() === t) {
            anchor = anchor.parentElement;
          }
          break;
        }
      }

      const sec = createSettingsSection();
      if (anchor && anchor.parentElement) {
        anchor.insertAdjacentElement('afterend', sec);
      } else {
        const body = container.querySelector('[class*="body"], [class*="content"]') || container;
        body.appendChild(sec);
      }
      return;
    }
  }

  function openFallbackModal() {
    const existing = document.getElementById('ml-duo-fallback-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'ml-duo-fallback-backdrop';

    const modal = document.createElement('div');
    modal.id = 'ml-duo-fallback-modal';
    modal.innerHTML = `
      <div class="ml-duo-modal-head">
        <span>mangalib-duo</span>
        <button type="button" class="ml-duo-modal-close" title="Закрыть">&times;</button>
      </div>
    `;

    const sec = createSettingsSection('modal');
    sec.style.marginTop = '10px';
    modal.appendChild(sec);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    modal.querySelector('.ml-duo-modal-close').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
  }

  // =========================================================================
  // 7. КЛАВИАТУРА, SPA-ПЕРЕХОДЫ И ИНИЦИАЛИЗАЦИЯ
  // =========================================================================

  function isAnyModalOpen() {
    if (document.getElementById('ml-duo-fallback-backdrop')) return true;
    const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"][class*="open"], [class*="drawer"][class*="open"]');
    return Array.from(dialogs).some(el => el.offsetParent !== null);
  }

  function setupListeners() {
    // Полный перехват горячих клавиш в capture-фазе, чтобы MangaLib не перелистывала главы сама
    window.addEventListener('keydown', (e) => {
      if (!isReaderPage()) return;

      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;

      // Alt+D — вкл/выкл разворот
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyD') {
        e.preventDefault();
        e.stopImmediatePropagation();
        saveSettings({ enabled: !settings.enabled });
        return;
      }

      // Alt+S — сдвиг обложки
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS') {
        e.preventDefault();
        e.stopImmediatePropagation();
        saveSettings({ coverAlone: !settings.coverAlone });
        return;
      }

      if (e.ctrlKey || e.altKey || e.metaKey) return;

      // F — полноэкранный режим
      if (e.code === 'KeyF' && !isAnyModalOpen()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleFullscreen();
        return;
      }

      if (!settings.enabled || !document.getElementById('ml-duo-stage') || isAnyModalOpen()) return;

      if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        stepSpread(settings.rtlNav ? 1 : -1);
      } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        stepSpread(settings.rtlNav ? -1 : 1);
      } else if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        stepSpread(e.shiftKey ? -1 : 1);
      }
    }, true);

    document.addEventListener('fullscreenchange', syncAllSettingsUI);
    document.addEventListener('webkitfullscreenchange', syncAllSettingsUI);

    // Отслеживание смены главы в SPA
    const onUrlChange = () => {
      if (location.href === currentUrl) return;
      const prevRoute = parseChapterRoute(new URL(currentUrl).pathname);
      currentUrl = location.href;
      const nextRoute = parseChapterRoute(location.pathname);

      if (!nextRoute) {
        chapterPages = [];
        pagesFromApi = false;
        chapterKey = '';
        apiFetchInFlightFor = '';
        cleanupDuoStage();
        return;
      }

      if (!prevRoute || prevRoute.key !== nextRoute.key) {
        chapterPages = [];
        pagesFromApi = false;
        chapterKey = '';
        apiFetchInFlightFor = '';
        currentSpreadIndex = 0;
        uiHidden = settings.cleanScreen;

        const stage = document.getElementById('ml-duo-stage');
        if (stage) stage.remove();
        restoreNativeContainer();
        scheduleRender();
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
      let needRender = false;
      let needSettings = false;

      for (const m of mutations) {
        if (m.target?.closest?.('#ml-duo-stage, #ml-duo-settings-section, #ml-duo-fallback-backdrop')) {
          continue;
        }
        if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
          needRender = true;
          needSettings = true;
        } else if (m.type === 'attributes' && m.target?.tagName === 'IMG') {
          needRender = true;
        }
      }

      if (needSettings) tryInjectIntoNativeSettings();
      if (needRender) scheduleRender();
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
      GM_registerMenuCommand('Настройки mangalib-duo', openFallbackModal);
      GM_registerMenuCommand('Вкл/Выкл разворот (Alt+D)', () => saveSettings({ enabled: !settings.enabled }));
    }

    setupListeners();
    tryInjectIntoNativeSettings();
    scheduleRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
