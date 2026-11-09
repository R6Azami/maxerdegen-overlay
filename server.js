const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3300;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Default Config
let config = {
  apiKey: '',
  username: 'degenmaxer',
  mode: 'real', // 'real' | 'demo'
  primaryCurrency: 'usdt',
  currencySymbol: '$',
  demoStartingBalance: 10000,
  demoBalance: 10000,
  demoWagered: 0,
  demoSpins: 0,
  demoBestMultiplier: 0,
  demoBestWinUsd: 0,
  autoDetectSlot: true,
  activeSlot: {
    title: 'Sweet Bonanza',
    provider: 'Pragmatic Play',
    rtp: '96.48%',
    image: 'https://cdn.hub88.io/pragmatic/pgp_sweetbonanza.jpg',
    source: 'preset'
  }
};

// Load saved config if exists
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...config, ...saved };
  } catch (err) {
    console.error('[Config] Failed to load config.json:', err.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('[Config] Failed to save config.json:', err.message);
  }
}

// In-Memory Live State
const state = {
  connected: false,
  authStatus: 'disconnected', // 'connected' | 'invalid_token' | 'disconnected' | 'connecting'
  lastError: null,
  userid: null,
  mode: config.mode || 'real',
  currencies: {},
  real: {
    startingBalanceUsd: null,
    currentBalanceUsd: 0,
    wallets: {},
    primaryCurrency: config.primaryCurrency || 'usdt',
    primaryBalance: 0,
    pnlUsd: 0,
    pnlPercent: 0,
    totalWageredUsd: 0,
    spinCount: 0,
    bestMultiplier: 0,
    bestWinUsd: 0,
    recentBets: [],
    lastBet: null
  },
  demo: {
    startingBalanceUsd: config.demoStartingBalance || 10000,
    currentBalanceUsd: config.demoBalance || 10000,
    pnlUsd: (config.demoBalance || 10000) - (config.demoStartingBalance || 10000),
    pnlPercent: config.demoStartingBalance ? (((config.demoBalance - config.demoStartingBalance) / config.demoStartingBalance) * 100) : 0,
    totalWageredUsd: config.demoWagered || 0,
    spinCount: config.demoSpins || 0,
    bestMultiplier: config.demoBestMultiplier || 0,
    bestWinUsd: config.demoBestWinUsd || 0,
    recentBets: [],
    lastBet: null
  },
  activeSlot: config.activeSlot,
  alert: null
};

// Server-Sent Events subscribers
const sseClients = new Set();

function broadcastState() {
  const payload = `data: ${JSON.stringify(getPublicState())}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function getPublicState() {
  const isReal = state.mode === 'real';
  const cur = isReal ? state.real : state.demo;
  return {
    connected: state.connected,
    authStatus: state.authStatus,
    lastError: state.lastError,
    mode: state.mode,
    currencySymbol: config.currencySymbol || state.currencySymbol || '$',
    activeSlot: state.activeSlot,
    current: {
      ...cur,
      currentBet: cur.currentBet || (cur.lastBet ? cur.lastBet.betUsd : 0),
      isBonusBuy: Boolean(cur.currentBet >= 100 || cur.lastBet?.isBonusBuy)
    },
    real: state.real,
    demo: {
      ...state.demo,
      currentBet: state.demo.currentBet || (state.demo.lastBet ? state.demo.lastBet.betUsd : 0),
      isBonusBuy: Boolean(state.demo.currentBet >= 100 || state.demo.lastBet?.isBonusBuy)
    },
    hasApiKey: Boolean(config.apiKey && config.apiKey.length > 5),
    apiKeyHint: config.apiKey ? `••••${config.apiKey.slice(-4)}` : '',
    alert: state.alert
  };
}

// Convert satoshi / raw int balance using currency decimals
function formatCryptoAmount(rawBalance, decimals = 8) {
  if (!rawBalance) return 0;
  const num = Number(rawBalance);
  return num / Math.pow(10, decimals);
}

// Recalculate Real USD balance across all user wallets
function updateRealBalances() {
  let totalUsd = 0;
  let primaryBal = 0;
  const pCur = state.real.primaryCurrency.toLowerCase();

  for (const [cur, w] of Object.entries(state.real.wallets)) {
    const curInfo = state.currencies[cur] || { decimals: 8, price: 1 };
    const decimals = curInfo.decimals || 8;
    const price = curInfo.price || (cur === 'usdt' || cur === 'usdc' || cur === 'dai' ? 1 : 0);
    const amount = formatCryptoAmount(w.balance, decimals);
    const usdValue = amount * price;

    w.formattedAmount = amount;
    w.usdValue = usdValue;
    w.price = price;
    totalUsd += usdValue;

    if (cur.toLowerCase() === pCur) {
      primaryBal = amount;
    }
  }

  state.real.currentBalanceUsd = Number(totalUsd.toFixed(2));
  state.real.primaryBalance = primaryBal;

  if (state.real.startingBalanceUsd === null && state.real.currentBalanceUsd > 0) {
    state.real.startingBalanceUsd = state.real.currentBalanceUsd;
  }

  if (state.real.startingBalanceUsd !== null && state.real.startingBalanceUsd > 0) {
    state.real.pnlUsd = Number((state.real.currentBalanceUsd - state.real.startingBalanceUsd).toFixed(2));
    state.real.pnlPercent = Number(((state.real.pnlUsd / state.real.startingBalanceUsd) * 100).toFixed(2));
  }

  broadcastState();
}

// WebSocket Connection to Chips.gg
let ws = null;
let wsReqId = 0;
let pollBetsInterval = null;
const pendingCalls = new Map();

function connectChipsWs() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
    return;
  }

  state.authStatus = 'connecting';
  state.connected = false;
  state.lastError = null;
  broadcastState();

  console.log('[Chips WS] Connecting to wss://api.chips.gg/prod/socket ...');

  try {
    ws = new WebSocket('wss://api.chips.gg/prod/socket');
  } catch (err) {
    console.error('[Chips WS] Connection failed:', err.message);
    state.authStatus = 'disconnected';
    state.lastError = err.message;
    broadcastState();
    setTimeout(connectChipsWs, 5000);
    return;
  }

  ws.onopen = () => {
    console.log('[Chips WS] Connected to Chips.gg socket!');
    state.connected = true;

    // Authenticate if API key is present
    if (config.apiKey && config.apiKey.trim().length > 0) {
      console.log('[Chips WS] Authenticating with API Key...');
      sendRpc('auth', 'authenticate', [config.apiKey.trim()], (err, res) => {
        if (err) {
          console.error('[Chips WS] Authentication failed:', err);
          state.authStatus = 'invalid_token';
          state.lastError = typeof err === 'string' ? err : (err.message || 'Invalid Token');
        } else {
          console.log('[Chips WS] Authenticated successfully as user:', res);
          state.authStatus = 'connected';
          state.userid = res;
          startPollingBets();
        }
        broadcastState();
      });
    } else {
      state.authStatus = 'disconnected';
      console.log('[Chips WS] No API key configured. Public stats only.');
      broadcastState();
    }
  };

  ws.onmessage = (event) => {
    try {
      handleSocketMessage(event.data);
    } catch (err) {
      console.error('[Chips WS] Message handling error:', err.message);
    }
  };

  ws.onerror = (err) => {
    console.error('[Chips WS] Socket error:', err.message || err);
    state.lastError = err.message || 'Socket error';
    broadcastState();
  };

  ws.onclose = (event) => {
    console.log('[Chips WS] Socket closed:', event.code, event.reason);
    state.connected = false;
    state.authStatus = 'disconnected';
    if (pollBetsInterval) clearInterval(pollBetsInterval);
    broadcastState();
    setTimeout(connectChipsWs, 4000);
  };
}

function sendRpc(channel, action, params = [], callback = null) {
  if (!ws || ws.readyState !== 1) {
    if (callback) callback(new Error('WebSocket not connected'));
    return;
  }
  const id = ++wsReqId;
  if (callback) pendingCalls.set(id, callback);
  const msg = [channel, id, action, params];
  ws.send(JSON.stringify(msg));
}

function handleSocketMessage(rawData) {
  let frames;
  try {
    frames = JSON.parse(rawData);
  } catch {
    return;
  }
  if (!Array.isArray(frames)) return;

  for (const frame of frames) {
    if (!Array.isArray(frame)) continue;
    const [channel, id, payload, err] = frame;

    // RPC Response
    if (id !== null && typeof id === 'number') {
      const cb = pendingCalls.get(id);
      if (cb) {
        pendingCalls.delete(id);
        if (err) cb(err, null);
        else cb(null, payload);
      }
      continue;
    }

    // Push State Updates: [channel, null, [path, data]]
    if (Array.isArray(payload)) {
      const [path = [], data] = payload;

      // Public currencies update
      if (channel === 'public') {
        if (path.length === 0 && data && data.currencies) {
          state.currencies = data.currencies;
          updateRealBalances();
        } else if (path[0] === 'currencies') {
          if (path.length === 1 && typeof data === 'object') {
            state.currencies = data;
          } else if (path.length === 2) {
            state.currencies[path[1]] = data;
          }
          updateRealBalances();
        }
      }

      // Wallet push: ["private", null, [["myWallets", "btc"], { balance: ... }]]
      if (channel === 'private' && path[0] === 'myWallets') {
        if (path.length === 2 && data) {
          state.real.wallets[path[1]] = data;
        } else if (path.length === 1 && typeof data === 'object') {
          state.real.wallets = { ...state.real.wallets, ...data };
        }
        updateRealBalances();
      }
    }
  }
}

// Poll recent bets to detect slot and track wins/losses in real time
function startPollingBets() {
  if (pollBetsInterval) clearInterval(pollBetsInterval);

  const fetchRecent = () => {
    if (!ws || ws.readyState !== 1 || state.authStatus !== 'connected') return;
    sendRpc('private', 'listMyBets', [{ game: 'casino', skip: 0, limit: 10 }], (err, bets) => {
      if (err || !Array.isArray(bets)) return;
      processIncomingBets(bets);
    });
  };

  fetchRecent();
  pollBetsInterval = setInterval(fetchRecent, 2500);
}

const seenBetIds = new Set();

function processIncomingBets(bets) {
  if (!bets || bets.length === 0) return;

  let hasNew = false;
  // Sort oldest to newest so sequence is preserved
  const sorted = [...bets].sort((a, b) => (a.created || 0) - (b.created || 0));

  for (const b of sorted) {
    const betId = b.id || b._id;
    if (!betId || seenBetIds.has(betId)) continue;
    seenBetIds.add(betId);
    hasNew = true;

    // Slot details
    const slotTitle = b.slotname || b.game?.title || b.title || 'Casino Slot';
    const provider = b.gameprovider || b.game?.provider || b.producer || 'Casino';
    const rtp = b.rtp ? `${b.rtp}%` : (b.game?.rtp ? `${b.game.rtp}%` : '96.5%');
    const image = b.game?.images?.s2 || b.game?.images?.bg || b.images?.s2 || '';

    // Auto-update active slot if enabled
    if (config.autoDetectSlot) {
      state.activeSlot = {
        title: slotTitle,
        provider: provider.toUpperCase(),
        rtp,
        image: image || state.activeSlot.image,
        source: 'auto-detected'
      };
      config.activeSlot = state.activeSlot;
    }

    // Currency & values
    const curInfo = state.currencies[b.currency] || { decimals: b.decimals || 8, price: b.price || 1 };
    const decimals = b.decimals || curInfo.decimals || 8;
    const price = b.price || curInfo.price || 1;

    const amountCrypto = formatCryptoAmount(b.amount, decimals);
    const winningsCrypto = formatCryptoAmount(b.winnings, decimals);
    const betUsd = Number((amountCrypto * price).toFixed(2));
    const winUsd = Number((winningsCrypto * price).toFixed(2));
    const profitUsd = Number((winUsd - betUsd).toFixed(2));
    const multiplier = Number(b.multiplier || (betUsd > 0 ? (winUsd / betUsd) : 0)).toFixed(2);

    const betRecord = {
      id: betId,
      time: b.created || Date.now(),
      slot: slotTitle,
      provider,
      betUsd,
      winUsd,
      profitUsd,
      multiplier: Number(multiplier),
      isWin: winUsd > betUsd
    };

    state.real.lastBet = betRecord;
    state.real.recentBets.unshift(betRecord);
    if (state.real.recentBets.length > 25) state.real.recentBets.pop();

    state.real.spinCount += 1;
    state.real.totalWageredUsd = Number((state.real.totalWageredUsd + betUsd).toFixed(2));

    if (Number(multiplier) > state.real.bestMultiplier) {
      state.real.bestMultiplier = Number(multiplier);
      state.real.bestWinUsd = winUsd;
    }

    // Trigger big win alert if multiplier >= 15x
    if (Number(multiplier) >= 15) {
      triggerWinAlert({
        slot: slotTitle,
        multiplier: Number(multiplier),
        winUsd,
        mode: 'REAL'
      });
    }
  }

  if (hasNew) {
    updateRealBalances();
    broadcastState();
  }
}

function triggerWinAlert() {
  state.alert = null;
  // Big win and max win celebration popoffs disabled per user request
}

// HTTP Server
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  console.log('[HTTP]', req.method, pathname);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE: /api/events
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(`data: ${JSON.stringify(getPublicState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // GET: /api/state
  if (pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPublicState()));
    return;
  }

  // POST: /api/config
  if (pathname === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.apiKey !== undefined) {
          config.apiKey = data.apiKey.trim();
        }
        if (data.mode !== undefined && (data.mode === 'real' || data.mode === 'demo')) {
          config.mode = data.mode;
          state.mode = data.mode;
        }
        if (data.currencySymbol !== undefined) {
          config.currencySymbol = data.currencySymbol;
        }
        if (data.autoDetectSlot !== undefined) {
          config.autoDetectSlot = Boolean(data.autoDetectSlot);
        }
        if (data.activeSlot !== undefined) {
          config.activeSlot = data.activeSlot;
          state.activeSlot = data.activeSlot;
        }
        if (data.demoStartingBalance !== undefined) {
          config.demoStartingBalance = Number(data.demoStartingBalance) || 10000;
          state.demo.startingBalanceUsd = config.demoStartingBalance;
        }
        if (data.demoBalance !== undefined) {
          config.demoBalance = Number(data.demoBalance) || 10000;
          state.demo.currentBalanceUsd = config.demoBalance;
          state.demo.pnlUsd = Number((state.demo.currentBalanceUsd - state.demo.startingBalanceUsd).toFixed(2));
          state.demo.pnlPercent = state.demo.startingBalanceUsd > 0
            ? Number(((state.demo.pnlUsd / state.demo.startingBalanceUsd) * 100).toFixed(2))
            : 0;
        }
        saveConfig();

        // If API key was updated, reconnect WebSocket
        if (data.apiKey !== undefined) {
          if (ws) ws.close();
          connectChipsWs();
        }

        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: getPublicState() }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

const slotCache = new Map();

async function lookupSlotCatalog(term) {
  if (!term) return null;
  const cleanTerm = term
    .replace(/^pragmaticplay-|^hacksawgaming-|^nolimitcity-|^relax-|^pushgaming-|^playngo-|^backseatgaming-/, '')
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .trim();

  try {
    const res = await fetch('https://api.chips.gg/prod/api/public/searchGames', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      body: JSON.stringify({ term: cleanTerm, limit: 5 })
    });
    const games = await res.json();
    if (games && games.length > 0) {
      const exact = games.find(g => 
        (g.slug && g.slug.toLowerCase() === term.toLowerCase()) || 
        (g._id && g._id.toLowerCase() === term.toLowerCase()) ||
        (g.title && g.title.toLowerCase() === cleanTerm.toLowerCase())
      );
      const g = exact || games[0];
      const img = g.images?.s2 || g.images?.s1 || g.images?.bg || g.url_thumb || '';
      return {
        title: g.title.trim(),
        provider: (g.producer || g.provider || 'CASINO').toUpperCase(),
        rtp: g.rtp ? `${g.rtp}%` : '96.5%',
        image: img,
        slug: g.slug || g._id || g.id
      };
    }
  } catch (err) {
    console.error('[Catalog Lookup Error]:', err.message);
  }
  return null;
}

  // POST: /api/browser-sync (Auto-sync from Chips.gg browser tab/userscript)
  if (pathname === '/api/browser-sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        console.log('[Browser Sync] Received:', JSON.stringify(data));
        let changed = false;

        // Auto-switch mode if detected from browser tab (e.g. playing demo vs real)
        if (data.isDemo !== undefined) {
          const newMode = data.isDemo ? 'demo' : 'real';
          if (state.mode !== newMode) {
            state.mode = newMode;
            config.mode = newMode;
            changed = true;
          }
        }

        // Auto-update active slot from catalog lookup or direct image
        const rawTerm = data.slug || data.slotTitle;
        const isGenericTerm = !rawTerm || ['casino slot', 'slot', 'casino', 'game', 'unknown', 'null', 'undefined'].includes(String(rawTerm).toLowerCase().trim());
        const lookupTerm = isGenericTerm ? null : rawTerm;
        let isSlotChanged = Boolean(data.isSlotChange);

        if (data.slotImage && typeof data.slotImage === 'string' && data.slotImage.startsWith('http') && state.activeSlot.image !== data.slotImage) {
          state.activeSlot.image = data.slotImage;
          config.activeSlot.image = data.slotImage;
          changed = true;
        }

        if (lookupTerm) {
          const info = await lookupSlotCatalog(lookupTerm);
          const newTitle = info?.title || data.slotTitle;
          const newSlug = info?.slug || data.slug;
          const newImage = data.slotImage || info?.image;
          const newProvider = (info?.provider || data.provider || state.activeSlot.provider || 'CASINO').toUpperCase();
          const newRtp = info?.rtp || data.rtp || state.activeSlot.rtp || '96.5%';

          if (newImage && state.activeSlot.image !== newImage) {
            state.activeSlot.image = newImage;
            config.activeSlot.image = newImage;
            changed = true;
          }

          if (isSlotChanged || (newTitle && state.activeSlot && (newTitle.toLowerCase() !== state.activeSlot.title?.toLowerCase() || (newSlug && newSlug.toLowerCase() !== state.activeSlot.slug?.toLowerCase())))) {
            isSlotChanged = true;
            state.activeSlot = {
              title: newTitle,
              provider: newProvider,
              rtp: newRtp,
              image: newImage || state.activeSlot.image,
              slug: newSlug || state.activeSlot.slug,
              source: info ? 'catalog-auto' : 'browser-tab'
            };
            config.activeSlot = state.activeSlot;
            changed = true;
          }
        }

        // Currency symbol sync (e.g. '€', '$')
        if (data.currencySymbol && typeof data.currencySymbol === 'string') {
          const sym = data.currencySymbol.trim();
          if (sym && sym !== config.currencySymbol) {
            config.currencySymbol = sym;
            state.currencySymbol = sym;
            changed = true;
          }
        }

        // Live Bet size sync (updates in realtime when user changes bet with +/-)
        if (data.betUsd !== undefined && !isNaN(Number(data.betUsd)) && Number(data.betUsd) > 0) {
          const b = Number(data.betUsd);
          if (state.demo.currentBet !== b && b < 100) {
            state.demo.currentBet = b;
            changed = true;
          }
        }

        // --- CRITICAL FIX 1: SLOT SWITCHING (Zero fake wins on 100k demo balances) ---
        if (isSlotChanged) {
          const initialBal = (data.balanceUsd !== undefined && Number(data.balanceUsd) > 0)
            ? Number(data.balanceUsd)
            : state.demo.currentBalanceUsd;

          console.log(`[Slot Switch] Game changed to: ${state.activeSlot.title}. Re-anchoring session baseline at ${initialBal}.`);
          state.demo.startingBalanceUsd = initialBal;
          state.demo.currentBalanceUsd = initialBal;
          state.demo.pnlUsd = 0;
          state.demo.pnlPercent = 0;
          state.demo.spinCount = 0;
          state.demo.totalWageredUsd = 0;
          state.demo.bestMultiplier = 0;
          state.demo.bestWinUsd = 0;
          state.demo.lastBet = null;
          state.demo.recentBets = [];
          state.demo._lastFingerprint = null;
          state.demo._lastRoundId = null;
          state.demo.isBonusBuyActive = false;
          state.demo.currentBuyCost = 0;
          if (data.betUsd && Number(data.betUsd) > 0 && Number(data.betUsd) < 100) {
            state.demo.currentBet = Number(data.betUsd);
          }
          state.alert = null;

          config.demoStartingBalance = initialBal;
          config.demoBalance = initialBal;
          config.demoWagered = 0;
          config.demoSpins = 0;
          config.demoBestMultiplier = 0;
          config.demoBestWinUsd = 0;
          saveConfig();
          broadcastState();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, slotSwitched: true, state: getPublicState() }));
          return;
        }

        // Auto-record demo spin or balance sync if reported by browser
        if (state.mode === 'demo') {
          const oldBal = state.demo.currentBalanceUsd;
          const hasNewBal = data.balanceUsd !== undefined && !isNaN(Number(data.balanceUsd)) && Number(data.balanceUsd) > 0;
          const newBal = hasNewBal ? Number(data.balanceUsd) : oldBal;
          const rawBet = Number(data.betUsd) > 0 ? Number(data.betUsd) : (state.demo.currentBet || 2);
          const win = Number(data.winUsd) || 0;
          const roundId = data.roundId || null;

          // --- CRITICAL FIX 2: DEMO BALANCE RELOAD GUARD ---
          if (data.isDemoReload || (hasNewBal && oldBal !== null && (newBal - oldBal > 2000) && win === 0 && !data.isSpin)) {
            console.log(`[Demo Reload Guard] Balance jumped from ${oldBal} to ${newBal}. Resetting starting baseline.`);
            state.demo.startingBalanceUsd = newBal;
            state.demo.currentBalanceUsd = newBal;
            state.demo.pnlUsd = 0;
            state.demo.pnlPercent = 0;
            state.demo.isBonusBuyActive = false;
            state.demo.currentBuyCost = 0;
            config.demoStartingBalance = newBal;
            config.demoBalance = newBal;
            saveConfig();
            broadcastState();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, demoReloaded: true, state: getPublicState() }));
            return;
          }

          // --- CRITICAL FIX 3: BONUS BUY & WAGERING ACCURACY ---
          const isExplicitBuy = Boolean(data.isBonusBuy || (data.buyCost && data.buyCost >= 50));
          const featureCost = Number(data.buyCost) > 0 ? Number(data.buyCost) : (isExplicitBuy ? rawBet : 0);

          let isRealSpin = Boolean(data.isSpin);
          if (roundId && roundId !== state.demo._lastRoundId) {
            isRealSpin = true;
            state.demo._lastRoundId = roundId;
          }

          // Update current live balance & PnL
          if (hasNewBal && state.demo.currentBalanceUsd !== newBal) {
            if (state.demo.startingBalanceUsd === null || state.demo.startingBalanceUsd === 0) {
              state.demo.startingBalanceUsd = newBal;
            }
            state.demo.currentBalanceUsd = newBal;
            state.demo.pnlUsd = Number((state.demo.currentBalanceUsd - state.demo.startingBalanceUsd).toFixed(2));
            state.demo.pnlPercent = state.demo.startingBalanceUsd > 0
              ? Number(((state.demo.pnlUsd / state.demo.startingBalanceUsd) * 100).toFixed(2))
              : 0;
            config.demoBalance = newBal;
            changed = true;
          }

          // Record Spin / Bonus Buy Stats
          if (isRealSpin || data.isBonusBuyEnd) {
            const spinFingerprint = roundId || `${rawBet}_${featureCost}_${win}_${newBal}_${Date.now()}`;
            if (spinFingerprint !== state.demo._lastFingerprint) {
              state.demo._lastFingerprint = spinFingerprint;

              let actualWin = win;
              if (actualWin === 0 && hasNewBal && oldBal !== null) {
                const balDelta = Number((newBal - oldBal).toFixed(2));
                const expectedCost = isExplicitBuy ? featureCost : rawBet;
                if (balDelta > -expectedCost) {
                  actualWin = Number((balDelta + expectedCost).toFixed(2));
                }
              }

              if (isExplicitBuy || featureCost >= 50) {
                // FEATURE BUY: Count wager cost ONCE
                const cost = featureCost > 0 ? featureCost : rawBet;
                if (!state.demo.isBonusBuyActive) {
                  state.demo.isBonusBuyActive = true;
                  state.demo.currentBuyCost = cost;
                  state.demo.totalWageredUsd = Number((state.demo.totalWageredUsd + cost).toFixed(2));
                  state.demo.spinCount += 1;
                }

                const profit = Number((actualWin - cost).toFixed(2));
                const mult = cost > 0 ? Number((actualWin / cost).toFixed(2)) : 0;

                if (mult > 1.0 && mult > state.demo.bestMultiplier) {
                  state.demo.bestMultiplier = mult;
                  state.demo.bestWinUsd = actualWin;
                }

                const betRecord = {
                  id: 'demo_' + Date.now(),
                  time: Date.now(),
                  slot: state.activeSlot.title,
                  provider: state.activeSlot.provider,
                  betUsd: cost,
                  winUsd: actualWin,
                  profitUsd: profit,
                  multiplier: mult,
                  isBonusBuy: true,
                  isWin: actualWin > cost
                };

                state.demo.lastBet = betRecord;
                state.demo.recentBets.unshift(betRecord);
                if (state.demo.recentBets.length > 25) state.demo.recentBets.pop();

                // Trigger Win Alert ONLY on real feature profit (>= 2x buy cost)
                if (mult >= 2.0 && actualWin > cost) {
                  triggerWinAlert({
                    slot: state.activeSlot.title,
                    multiplier: mult,
                    winUsd: actualWin,
                    mode: 'DEMO',
                    isBonusBuy: true
                  });
                }
              } else if (data.isFreeSpin) {
                // Free spin inside an active bonus round -> Wager cost is 0, do not add to totalWageredUsd!
                console.log(`[Free Spin] Free spin rolling. Win so far: ${actualWin}`);
              } else {
                // REGULAR BASE GAME SPIN
                state.demo.isBonusBuyActive = false;
                const wagerCost = rawBet;
                const profit = Number((actualWin - wagerCost).toFixed(2));
                const mult = wagerCost > 0 ? Number((actualWin / wagerCost).toFixed(2)) : 0;

                state.demo.totalWageredUsd = Number((state.demo.totalWageredUsd + wagerCost).toFixed(2));
                state.demo.spinCount += 1;

                if (mult > 1.0 && mult > state.demo.bestMultiplier) {
                  state.demo.bestMultiplier = mult;
                  state.demo.bestWinUsd = actualWin;
                }

                const betRecord = {
                  id: 'demo_' + Date.now(),
                  time: Date.now(),
                  slot: state.activeSlot.title,
                  provider: state.activeSlot.provider,
                  betUsd: wagerCost,
                  winUsd: actualWin,
                  profitUsd: profit,
                  multiplier: mult,
                  isBonusBuy: false,
                  isWin: actualWin > wagerCost
                };

                state.demo.lastBet = betRecord;
                state.demo.recentBets.unshift(betRecord);
                if (state.demo.recentBets.length > 25) state.demo.recentBets.pop();

                if (mult >= 15.0 && actualWin > wagerCost) {
                  triggerWinAlert({
                    slot: state.activeSlot.title,
                    multiplier: mult,
                    winUsd: actualWin,
                    mode: 'DEMO',
                    isBonusBuy: false
                  });
                }
              }

              config.demoWagered = state.demo.totalWageredUsd;
              config.demoSpins = state.demo.spinCount;
              config.demoBestMultiplier = state.demo.bestMultiplier;
              config.demoBestWinUsd = state.demo.bestWinUsd;
              changed = true;
            }
          }
        }

        if (changed) {
          saveConfig();
          broadcastState();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: getPublicState() }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST: /api/reset-session
  if (pathname === '/api/reset-session' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const targetMode = state.mode;
      if (targetMode === 'real') {
        state.real.startingBalanceUsd = state.real.currentBalanceUsd;
        state.real.pnlUsd = 0;
        state.real.pnlPercent = 0;
        state.real.totalWageredUsd = 0;
        state.real.spinCount = 0;
        state.real.bestMultiplier = 0;
        state.real.bestWinUsd = 0;
        state.real.recentBets = [];
        state.real.lastBet = null;
      } else {
        state.demo.startingBalanceUsd = state.demo.currentBalanceUsd;
        state.demo.pnlUsd = 0;
        state.demo.pnlPercent = 0;
        state.demo.totalWageredUsd = 0;
        state.demo.spinCount = 0;
        state.demo.bestMultiplier = 0;
        state.demo.bestWinUsd = 0;
        state.demo.recentBets = [];
        state.demo.lastBet = null;
        state.demo.isBonusBuyActive = false;
        state.demo.currentBuyCost = 0;
        state.demo._lastFingerprint = null;
        state.alert = null;
        config.demoStartingBalance = state.demo.startingBalanceUsd;
        config.demoBalance = state.demo.currentBalanceUsd;
        config.demoWagered = 0;
        config.demoSpins = 0;
        config.demoBestMultiplier = 0;
        config.demoBestWinUsd = 0;
        saveConfig();
      }
      broadcastState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state: getPublicState() }));
    });
    return;
  }

  // POST: /api/quick-adjust (Instant balance delta e.g. +100, -50, or set balance)
  if (pathname === '/api/quick-adjust' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { delta, newBalance } = JSON.parse(body);
        if (newBalance !== undefined) {
          const bal = Number(newBalance);
          if (!isNaN(bal)) {
            state.demo.currentBalanceUsd = bal;
            config.demoBalance = bal;
          }
        } else if (delta !== undefined) {
          const d = Number(delta);
          if (!isNaN(d)) {
            state.demo.currentBalanceUsd = Number((state.demo.currentBalanceUsd + d).toFixed(2));
            config.demoBalance = state.demo.currentBalanceUsd;
          }
        }
        state.demo.pnlUsd = Number((state.demo.currentBalanceUsd - state.demo.startingBalanceUsd).toFixed(2));
        state.demo.pnlPercent = state.demo.startingBalanceUsd > 0
          ? Number(((state.demo.pnlUsd / state.demo.startingBalanceUsd) * 100).toFixed(2))
          : 0;
        saveConfig();
        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: getPublicState() }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST: /api/demo-spin (Record simulated demo spin)
  if (pathname === '/api/demo-spin' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { betUsd, winUsd, slotTitle } = JSON.parse(body);
        const bet = Number(betUsd) || 0;
        const win = Number(winUsd) || 0;
        const profit = Number((win - bet).toFixed(2));
        const mult = bet > 0 ? Number((win / bet).toFixed(2)) : 0;

        state.demo.currentBalanceUsd = Number((state.demo.currentBalanceUsd + profit).toFixed(2));
        state.demo.pnlUsd = Number((state.demo.currentBalanceUsd - state.demo.startingBalanceUsd).toFixed(2));
        state.demo.pnlPercent = state.demo.startingBalanceUsd > 0
          ? Number(((state.demo.pnlUsd / state.demo.startingBalanceUsd) * 100).toFixed(2))
          : 0;
        state.demo.totalWageredUsd = Number((state.demo.totalWageredUsd + bet).toFixed(2));
        state.demo.spinCount += 1;

        if (mult > state.demo.bestMultiplier) {
          state.demo.bestMultiplier = mult;
          state.demo.bestWinUsd = win;
        }

        const betRecord = {
          id: 'demo_' + Date.now(),
          time: Date.now(),
          slot: slotTitle || state.activeSlot.title,
          provider: state.activeSlot.provider,
          betUsd: bet,
          winUsd: win,
          profitUsd: profit,
          multiplier: mult,
          isWin: win > bet
        };

        state.demo.lastBet = betRecord;
        state.demo.recentBets.unshift(betRecord);
        if (state.demo.recentBets.length > 25) state.demo.recentBets.pop();

        config.demoBalance = state.demo.currentBalanceUsd;
        config.demoWagered = state.demo.totalWageredUsd;
        config.demoSpins = state.demo.spinCount;
        config.demoBestMultiplier = state.demo.bestMultiplier;
        config.demoBestWinUsd = state.demo.bestWinUsd;
        saveConfig();

        if (mult >= 15) {
          triggerWinAlert({
            slot: slotTitle || state.activeSlot.title,
            multiplier: mult,
            winUsd: win,
            mode: 'DEMO'
          });
        }

        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: getPublicState() }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST: /api/test-alert
  if (pathname === '/api/test-alert' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        triggerWinAlert({
          slot: data.slot || state.activeSlot.title,
          multiplier: Number(data.multiplier) || 88.5,
          winUsd: Number(data.winUsd) || 177.0,
          mode: state.mode.toUpperCase()
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // GET: /api/search-games?q=sweet
  if (pathname === '/api/search-games') {
    const q = parsedUrl.query.q || '';
    if (!q || q.length < 2) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }

    fetch('https://api.chips.gg/prod/api/public/searchGames', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      body: JSON.stringify({ term: q, limit: 6 })
    })
      .then(r => r.json())
      .then(games => {
        const results = (games || []).map(g => ({
          title: g.title,
          provider: (g.producer || g.provider || 'Casino').toUpperCase(),
          rtp: g.rtp ? `${g.rtp}%` : '96.5%',
          image: g.images?.s2 || g.images?.bg || g.url_thumb || '',
          slug: g.slug || g.id
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  // Static File Serving
  let filePath = path.join(PUBLIC_DIR, pathname === '/' || pathname === '/control' ? 'control.html' : pathname);
  if (pathname === '/overlay' || pathname === '/tracker' || pathname === '/hud') {
    filePath = path.join(PUBLIC_DIR, 'overlay.html');
  } else if (pathname === '/overlay-fhd' || pathname === '/stream-overlay' || pathname === '/frame') {
    filePath = path.join(PUBLIC_DIR, 'overlay-fhd.html');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Chips.gg Stream Overlay Server Running!`);
  console.log(`======================================================`);
  console.log(`📺 OBS Browser Source URL: http://localhost:${PORT}/overlay`);
  console.log(`🎛️  Streamer Control Panel: http://localhost:${PORT}/control`);
  console.log(`======================================================\n`);

  connectChipsWs();
});
