// ==UserScript==
// @name         Chips.gg Stream Overlay Auto-Sync
// @namespace    http://localhost:3300/
// @version      7.0
// @description  100% AUTOMATIC real-time slot and demo spin tracking (Balance, Bet, Slot, PnL, Bonus Buys) to your OBS overlay
// @author       degenmaxer
// @match        *://chips.gg/*
// @match        *://*.chips.gg/*
// @match        https://chips.gg/*
// @match        https://*.chips.gg/*
// @match        https://*.hacksawgaming.com/*
// @match        https://*.pragmaticplay.net/*
// @match        https://*.pragmaticplay.com/*
// @match        https://*.hub88.io/*
// @match        https://*.relax-gaming.com/*
// @match        https://*.nolimitcity.com/*
// @match        https://*.backseatgaming.com/*
// @match        https://*/*
// @match        http://*/*
// @include      *
// @all-frames   true
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  const SERVER_URL = 'http://localhost:3300/api/browser-sync';
  const winObj = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  // Safe HTTP POST using Tampermonkey elevated privileges
  function syncToOverlay(payload) {
    if (!payload.slotTitle && currentSlotInfo.title) {
      payload.slotTitle = currentSlotInfo.title;
    }
    if (!payload.slug && currentSlotInfo.slug) {
      payload.slug = currentSlotInfo.slug;
    }
    if (!payload.provider && currentSlotInfo.provider) {
      payload.provider = currentSlotInfo.provider;
    }
    if (!payload.slotImage && currentSlotInfo.image) {
      payload.slotImage = currentSlotInfo.image;
    }
    Object.keys(payload).forEach(k => {
      if (payload[k] === '' || payload[k] === null || payload[k] === undefined) {
        delete payload[k];
      }
    });

    const dataStr = JSON.stringify(payload);
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      GM_xmlhttpRequest({
        method: 'POST',
        url: SERVER_URL,
        headers: { 'Content-Type': 'application/json' },
        data: dataStr,
        onload: function() {},
        onerror: function() {}
      });
    } else {
      try {
        fetch(SERVER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: dataStr
        }).catch(() => {});
      } catch (e) {}
    }
  }

  // ========================================================
  // 1. UNIVERSAL MONEY PARSER (Handles '€4,998.00', '€2.00', '18.00', '96.980,20 €')
  // ========================================================
  function parseMoneyNum(str) {
    if (!str) return null;
    let s = str.trim().replace(/[^0-9.,]/g, '');
    if (!s) return null;

    if (s.includes(',') && s.includes('.')) {
      if (s.lastIndexOf(',') < s.lastIndexOf('.')) {
        s = s.replace(/,/g, ''); // 4,998.00 -> 4998.00
      } else {
        s = s.replace(/\./g, '').replace(',', '.'); // 4.998,00 -> 4998.00
      }
    } else if (s.includes(',')) {
      const parts = s.split(',');
      if (parts.length === 2 && parts[1].length <= 2) {
        s = s.replace(',', '.'); // 18,00 -> 18.00
      } else {
        s = s.replace(/,/g, ''); // 1,000 -> 1000
      }
    }

    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  // ========================================================
  // 2. DOM TEXT & HUD SCANNER
  // ========================================================
  function getCleanScanText(doc) {
    if (!doc || !doc.body) return '';
    try {
      // 1. Priority: scan game container directly
      const gameArea = doc.querySelector('#game-container, .game-container, [class*="game-player"], [class*="game-wrapper"], [class*="play-view"], main');
      if (gameArea && gameArea.innerText && (gameArea.innerText.includes('BALANCE') || gameArea.innerText.includes('BET'))) {
        return gameArea.innerText;
      }

      // 2. Clone body and remove site headers / King of the Hill ticker to prevent false bet matches
      const clone = doc.body.cloneNode(true);
      const junk = clone.querySelectorAll('header, nav, [class*="header"], [class*="koth"], [class*="leaderboard"], [class*="navbar"]');
      junk.forEach(el => el.remove());
      return clone.innerText || clone.textContent || '';
    } catch (e) {
      let t = doc.body ? (doc.body.innerText || '') : '';
      return t.replace(/King\s+of\s+The\s+Hill[\s\S]*?Prize:[^\n]+/gi, '');
    }
  }

  function scanDocumentForHUD(doc) {
    if (!doc) return null;
    const text = getCleanScanText(doc);
    if (!text || text.length < 5) return null;

    let balance = null;
    let bet = null;
    let currency = null;
    let buyCost = null;
    let isBonusBuy = false;

    // 1. Balance Regex with attached currency
    // e.g. "DEMO BALANCE\n€4,998.00", "BALANCE €96,980.20", "€4,688.60"
    const balMatch = text.match(/(?:\bdemo\s+balance\b|\btotal\s+balance\b|\bbalance\b|\bsolde\b|\bguthaben\b|\bsaldo\b|\bcredit[s]?\b)(?!\w)[\s\S]{0,35}?([€$£¥₹₽]|EUR|USD|GBP)?\s*([0-9.,]{2,15})\s*([€$£¥₹₽]|EUR|USD|GBP)?/i);
    if (balMatch) {
      const rawCurr = balMatch[1] || balMatch[3];
      if (rawCurr) {
        const c = rawCurr.toUpperCase();
        currency = c === 'EUR' ? '€' : (c === 'USD' ? '$' : (c === 'GBP' ? '£' : rawCurr));
      }
      balance = parseMoneyNum(balMatch[2]);
    }

    // 2. Bet Regex (Word boundary to NEVER match "bets:" from King of the Hill)
    // e.g. "DEMO BET\n€2.00", "BET AMOUNT €18.00", "BET €2.00", "STAKE €2.00"
    const betMatch = text.match(/(?:\bdemo\s+bet\b|\btotal\s+bet\b|\bbet\s+amount\b|\bstake\b|\bmise\b|\beinsatz\b|\bbet\b)(?!\w)[\s\S]{0,35}?([€$£¥₹₽]|EUR|USD|GBP)?\s*([0-9.,]{1,8})\s*([€$£¥₹₽]|EUR|USD|GBP)?/i);
    if (betMatch) {
      const rawCurr = betMatch[1] || betMatch[3];
      if (!currency && rawCurr) {
        const c = rawCurr.toUpperCase();
        currency = c === 'EUR' ? '€' : (c === 'USD' ? '$' : (c === 'GBP' ? '£' : rawCurr));
      }
      bet = parseMoneyNum(betMatch[2]);
    }

    // 3. Feature / Bonus Buy Detection (e.g. "BUY €782.00", "BUY BONUS")
    const buyMatch = text.match(/(?:\bbuy\s+bonus\b|\bbuy\s+feature\b|\bfeature\s+buy\b|\bbuy\b)(?!\w)[\s\S]{0,35}?([€$£¥₹₽]|EUR|USD|GBP)?\s*([0-9.,]{2,10})\s*([€$£¥₹₽]|EUR|USD|GBP)?/i);
    if (buyMatch) {
      const bVal = parseMoneyNum(buyMatch[2]);
      if (bVal && bVal >= 20) {
        buyCost = bVal;
        isBonusBuy = true;
        const rawCurr = buyMatch[1] || buyMatch[3];
        if (!currency && rawCurr) {
          const c = rawCurr.toUpperCase();
          currency = c === 'EUR' ? '€' : (c === 'USD' ? '$' : rawCurr);
        }
      }
    }

    if (bet && bet >= 100) {
      isBonusBuy = true;
      if (!buyCost) buyCost = bet;
    }

    if (balance !== null || bet !== null || buyCost !== null) {
      return { balance, bet, currency, buyCost, isBonusBuy };
    }
    return null;
  }

  // Scan accessible child iframes if top frame
  function scanAllAccessibleFrames() {
    let best = scanDocumentForHUD(document);
    if (best && best.balance !== null && best.bet !== null) return best;

    try {
      const iframes = document.querySelectorAll('iframe');
      for (const f of iframes) {
        try {
          if (f.contentDocument) {
            const sub = scanDocumentForHUD(f.contentDocument);
            if (sub) {
              best = { ...(best || {}), ...sub };
              if (best.balance !== null && best.bet !== null) return best;
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

    return best;
  }

  // Extract accurate slot thumbnail from Chips page DOM
  function getPageSlotImage() {
    try {
      const img = document.querySelector('img[src*="cdn.hub88.io"], [class*="game"] img, [class*="review"] img, [class*="slot"] img');
      if (img && img.src && !img.src.includes('avatar') && !img.src.includes('logo')) {
        return img.src;
      }
    } catch (e) {}
    return null;
  }

  // ========================================================
  // 3. CHIPS.GG SLUG & MODE DETECTOR (Parent & Iframe)
  // ========================================================
  let currentSlotInfo = {
    title: '',
    provider: '',
    slug: '',
    image: null,
    isDemo: true
  };

  function resolveChipsSlug() {
    if (window.location.hostname.includes('chips.gg') && window.location.pathname.startsWith('/play/')) {
      return window.location.pathname.replace('/play/', '').split('/')[0];
    }
    if (document.referrer && document.referrer.includes('chips.gg/play/')) {
      try {
        const u = new URL(document.referrer);
        if (u.pathname.startsWith('/play/')) {
          return u.pathname.replace('/play/', '').split('/')[0];
        }
      } catch (e) {}
    }
    return '';
  }

  function checkChipsPage() {
    const slug = resolveChipsSlug();
    if (!slug) return;

    // Detect if Fun Play (demo) or Real Play
    let isDemo = true;
    try {
      const realBtn = Array.from(document.querySelectorAll('button, div, a')).find(el => {
        const t = (el.textContent || '').trim().toLowerCase();
        return t === 'real play';
      });
      if (realBtn && (realBtn.classList.contains('active') || realBtn.getAttribute('aria-selected') === 'true')) {
        isDemo = false;
      }
    } catch (e) {}

    // Title & Provider resolution
    let clean = slug.replace(/^[a-z0-9]+-/, '').replace(/-/g, ' ');
    let title = clean.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    let provider = 'CASINO';
    const s = slug.toLowerCase();
    if (s.includes('hacksaw')) provider = 'HACKSAW GAMING';
    else if (s.includes('pragmatic')) provider = 'PRAGMATIC PLAY';
    else if (s.includes('nolimit')) provider = 'NOLIMIT CITY';
    else if (s.includes('relax')) provider = 'RELAX GAMING';
    else if (s.includes('push')) provider = 'PUSH GAMING';
    else if (s.includes('playngo')) provider = 'PLAY\'N GO';
    else if (s.includes('backseat')) provider = 'BACKSEAT GAMING';

    const pageImg = getPageSlotImage();

    currentSlotInfo = {
      title,
      provider,
      slug,
      image: pageImg,
      isDemo
    };
  }

  setInterval(checkChipsPage, 800);
  checkChipsPage();

  // ========================================================
  // 4. CONTINUOUS LIVE SCANNER & STATE MACHINE (Every 600ms)
  // ========================================================
  let lastKnownSlug = '';
  let lastKnownBalance = null;
  let lastKnownBet = null;
  let inBonusRound = false;
  let activeBonusCost = 0;
  let lastSentStateKey = '';

  function runLiveScanner() {
    // 1. Handle Slot Navigation / Switch
    if (currentSlotInfo.slug && currentSlotInfo.slug !== lastKnownSlug) {
      console.log(`[Chips Stream Sync] Slot switched to: ${currentSlotInfo.slug}. Resetting baseline.`);
      lastKnownSlug = currentSlotInfo.slug;
      lastKnownBalance = null; // Re-anchor baseline for new slot!
      lastKnownBet = null;
      inBonusRound = false;
      activeBonusCost = 0;

      const pageImg = getPageSlotImage();
      syncToOverlay({
        isSlotChange: true,
        slotTitle: currentSlotInfo.title,
        provider: currentSlotInfo.provider,
        slug: currentSlotInfo.slug,
        slotImage: pageImg || currentSlotInfo.image,
        isDemo: currentSlotInfo.isDemo
      });
      return;
    }

    // 2. Scan HUD
    const hud = scanAllAccessibleFrames();
    const pageImg = getPageSlotImage();

    if (!hud) {
      if (window === window.top && window.location.hostname.includes('chips.gg') && currentSlotInfo.slug) {
        syncToOverlay({
          slotTitle: currentSlotInfo.title,
          provider: currentSlotInfo.provider,
          slug: currentSlotInfo.slug,
          slotImage: pageImg || currentSlotInfo.image,
          isDemo: currentSlotInfo.isDemo
        });
      }
      return;
    }

    const bal = hud.balance;
    const bet = hud.bet;
    const curr = hud.currency;
    const buyCost = hud.buyCost;
    const isBonusBuy = Boolean(hud.isBonusBuy || (buyCost && buyCost >= 50));

    // First time reading balance on this slot -> Anchor baseline without firing fake spin!
    if (lastKnownBalance === null && bal !== null) {
      lastKnownBalance = bal;
      if (bet !== null) lastKnownBet = bet;

      console.log(`[Chips Stream Sync] Initial slot balance anchored: ${curr || ''}${bal}`);
      syncToOverlay({
        isSlotChange: true,
        isDemo: currentSlotInfo.isDemo,
        slotTitle: currentSlotInfo.title,
        provider: currentSlotInfo.provider,
        slug: currentSlotInfo.slug,
        slotImage: pageImg || currentSlotInfo.image,
        balanceUsd: bal,
        betUsd: bet || 2,
        currencySymbol: curr || '€',
        isSpin: false,
        winUsd: 0
      });
      return;
    }

    // Evaluate Balance Delta on the SAME slot
    let isSpin = false;
    let win = 0;
    let isDemoReload = false;
    let isBonusBuyEnd = false;

    if (lastKnownBalance !== null && bal !== null) {
      const delta = Number((bal - lastKnownBalance).toFixed(2));

      if (delta < -0.01) {
        // Balance decreased -> Spin or Bonus Buy placed!
        isSpin = true;
        const lossAmount = Math.abs(delta);

        if (lossAmount >= 50 || (bet && lossAmount >= bet * 15) || isBonusBuy) {
          inBonusRound = true;
          activeBonusCost = lossAmount;
          console.log(`[Chips Stream Sync] Feature Buy initiated! Cost: ${lossAmount}`);
        }
      } else if (delta > 0.01) {
        // Balance increased -> Win or Demo Reload!
        if (delta > 2000 && lastKnownBalance < 1000) {
          isDemoReload = true;
          console.log(`[Chips Stream Sync] Demo balance reload detected: +${delta}`);
        } else if (inBonusRound) {
          isBonusBuyEnd = true;
          win = delta;
          inBonusRound = false;
          console.log(`[Chips Stream Sync] Bonus round finished. Total Win: ${win} on Buy: ${activeBonusCost}`);
        } else {
          isSpin = true;
          win = delta + (bet || lastKnownBet || 0);
        }
      }
    }

    if (bal !== null) lastKnownBalance = bal;
    if (bet !== null) lastKnownBet = bet;

    const stateKey = `${currentSlotInfo.slug}_${bal}_${bet}_${curr}_${isBonusBuy}_${isSpin ? Date.now() : ''}`;
    if (stateKey === lastSentStateKey && !isSpin && !isDemoReload && !isBonusBuyEnd) {
      return;
    }
    lastSentStateKey = stateKey;

    const payload = {
      isDemo: currentSlotInfo.isDemo,
      isSpin: isSpin,
      isDemoReload: isDemoReload,
      isBonusBuy: isBonusBuy || inBonusRound,
      isBonusBuyEnd: isBonusBuyEnd,
      buyCost: activeBonusCost || buyCost || 0
    };

    if (currentSlotInfo.slug) {
      payload.slotTitle = currentSlotInfo.title;
      payload.provider = currentSlotInfo.provider;
      payload.slug = currentSlotInfo.slug;
    }
    if (pageImg || currentSlotInfo.image) {
      payload.slotImage = pageImg || currentSlotInfo.image;
    }
    if (bal !== null) payload.balanceUsd = bal;
    if (bet !== null) payload.betUsd = bet;
    if (win > 0) payload.winUsd = win;
    if (curr) payload.currencySymbol = curr;

    console.log('[Chips Stream Sync] DOM Sync Payload:', payload);
    syncToOverlay(payload);
  }

  setInterval(runLiveScanner, 600);
  setTimeout(runLiveScanner, 200);

  // ========================================================
  // 5. NETWORK & WEBSOCKET ENGINE HOOKS (For Millisecond Precision)
  // ========================================================
  let lastSentBet = 2.00;
  let lastReportedKey = '';

  function parseVal(v) {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = parseMoneyNum(v);
      return n !== null ? n : undefined;
    }
    if (typeof v === 'object' && v !== null) {
      return parseVal(v.amount ?? v.balance ?? v.value ?? v.cash);
    }
    return undefined;
  }

  function robustExtract(obj, fallbackBet = 0) {
    if (!obj || typeof obj !== 'object') return null;

    let balances = [];
    let win = undefined;
    let bet = undefined;
    let curr = undefined;

    function search(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 6) return;

      for (const key of Object.keys(node)) {
        const lk = key.toLowerCase();
        const val = node[key];

        if (lk === 'currency' && typeof val === 'string') {
          const c = val.toUpperCase();
          curr = c === 'EUR' ? '€' : (c === 'USD' ? '$' : val);
        }

        if (lk.includes('balance') || lk.includes('wallet') || lk === 'cash' || lk === 'credits') {
          const num = parseVal(val);
          if (num !== undefined) balances.push({ key: lk, val: num });
        }

        if (win === undefined) {
          if (lk === 'win' || lk === 'totalwin' || lk === 'total_win' || lk === 'roundwin' || lk === 'payout' || lk === 'winnings' || lk === 'wonamount') {
            const num = parseVal(val);
            if (num !== undefined) win = num;
          } else if ((lk === 'round_result' || lk === 'roundresult') && typeof val === 'object' && val !== null) {
            const num = parseVal(val.total_win ?? val.totalWin ?? val.win ?? val.payout);
            if (num !== undefined) win = num;
          }
        }

        if (bet === undefined) {
          if (lk === 'bet' || lk === 'wager' || lk === 'totalbet' || lk === 'total_bet' || lk === 'stake' || lk === 'betamount') {
            const num = parseVal(val);
            if (num !== undefined) bet = num;
          }
        }

        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          search(val, depth + 1);
        }
      }
    }

    search(obj);

    let chosenBalance = undefined;
    const demoMatch = balances.find(b => (b.key.includes('demo') || b.key.includes('fun') || b.key.includes('virtual')) && b.val > 0);
    if (demoMatch) chosenBalance = demoMatch.val;
    else if (balances.length > 0) chosenBalance = balances[0].val;

    if (chosenBalance !== undefined || win !== undefined || bet !== undefined) {
      let b = chosenBalance;
      let w = win ?? 0;
      let s = bet ?? fallbackBet;

      // Cents normalization (e.g. 499800 -> 4998.00, 200 -> 2.00)
      if (b !== undefined && b > 20000 && Number.isInteger(b)) {
        b = b / 100;
        w = w / 100;
        if (s >= 20 && Number.isInteger(s)) s = s / 100;
      }

      return {
        bet: isNaN(s) ? fallbackBet : s,
        win: isNaN(w) ? 0 : w,
        balance: isNaN(b) ? undefined : b,
        currency: curr
      };
    }
    return null;
  }

  function handlePayload(text, isRequest = false, isEngineEvent = false) {
    if (!text || typeof text !== 'string') return;

    if (text.includes('balance=') && (text.includes('tw=') || text.includes('c='))) {
      try {
        const p = new URLSearchParams(text);
        const balance = parseFloat(p.get('balance') || p.get('balance_cash') || 0);
        const win = parseFloat(p.get('tw') || p.get('w') || 0);
        let bet = 0;
        if (p.has('c') && p.has('l')) {
          bet = parseFloat(p.get('c')) * parseFloat(p.get('l'));
        }
        dispatchSpin({ bet, win, balance }, isEngineEvent);
        return;
      } catch (e) {}
    }

    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const json = JSON.parse(text);
        if (isRequest) {
          const reqData = robustExtract(json);
          if (reqData && reqData.bet > 0) lastSentBet = reqData.bet;
          return;
        }

        const resData = robustExtract(json, lastSentBet);
        if (resData && (resData.bet > 0 || resData.win > 0 || resData.balance !== undefined)) {
          dispatchSpin(resData, isEngineEvent);
        }
      } catch (e) {}
    }
  }

  function dispatchSpin(data, isEngineEvent = false) {
    const bet = Number(data.bet) || 0;
    const win = Number(data.win) || 0;
    const bal = data.balance !== undefined ? Number(data.balance) : undefined;
    const curr = data.currency;

    const key = `${bet.toFixed(2)}_${win.toFixed(2)}_${bal !== undefined ? bal.toFixed(2) : ''}`;
    if (key === lastReportedKey && !isEngineEvent) {
      return;
    }
    lastReportedKey = key;

    let isSpin = isEngineEvent;
    if (lastKnownBalance !== null && bal !== undefined && Math.abs(bal - lastKnownBalance) > 0.001) {
      isSpin = true;
    }
    if (bal !== undefined) lastKnownBalance = bal;
    if (bet > 0) lastKnownBet = bet;

    const pageImg = getPageSlotImage();
    const payload = {
      isDemo: true,
      isSpin: isSpin,
      betUsd: bet > 0 ? bet : (lastKnownBet || 0),
      winUsd: win,
      balanceUsd: bal
    };
    if (curr) payload.currencySymbol = curr;
    if (currentSlotInfo.slug) {
      payload.slotTitle = currentSlotInfo.title;
      payload.provider = currentSlotInfo.provider;
      payload.slug = currentSlotInfo.slug;
    }
    if (pageImg || currentSlotInfo.image) {
      payload.slotImage = pageImg || currentSlotInfo.image;
    }

    syncToOverlay(payload);
  }

  // Hook Fetch
  const origFetch = winObj.fetch;
  winObj.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const clone = res.clone();
      clone.text().then(t => handlePayload(t, false, true)).catch(() => {});
    } catch (e) {}
    return res;
  };

  // Hook XMLHttpRequest
  const origOpen = winObj.XMLHttpRequest.prototype.open;
  const origSend = winObj.XMLHttpRequest.prototype.send;
  winObj.XMLHttpRequest.prototype.open = function(method, url) {
    this._url = url;
    return origOpen.apply(this, arguments);
  };
  winObj.XMLHttpRequest.prototype.send = function(body) {
    if (body) {
      try { handlePayload(body, true); } catch (e) {}
    }
    this.addEventListener('load', function() {
      try {
        if (this.responseText) handlePayload(this.responseText, false, true);
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // Hook WebSocket
  const OrigWS = winObj.WebSocket;
  winObj.WebSocket = function(...args) {
    const ws = new OrigWS(...args);
    ws.addEventListener('message', function(evt) {
      try {
        if (typeof evt.data === 'string') handlePayload(evt.data, false, true);
      } catch (e) {}
    });
    return ws;
  };
  winObj.WebSocket.prototype = OrigWS.prototype;

  console.log('[Chips Stream Sync] Auto-Tracker v7.0 loaded successfully.');
})();
