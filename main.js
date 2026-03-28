#!/usr/bin/env node

/**
 * 🛰️  VWAP HYBRID ENGINE — UNIFIED SNIPER & TURBO (Turbo V2)
 * 📊  Logic: High Density (>=85%) = Sniper | Else = Turbo
 * 💰  Fixed Budget: 10$ per Slot | Max 10 Slots
 * 🛡️  Pro Trailing: Breakeven (+1%), Lock Profit (+2%), Tiered Trailing (+4%+)
 * 🧺  Basket Profit: Closes stagnant trades in USD profit (>1h, -1% to +1%)
 * 📈  Entry Filters: VWAP Pos, Volume Spike (1.5x), Price Momentum, Top 200
 * 💻  Compatible with Node.js 18+ (ESM)
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
    // Independent File Paths in STANDALONE Folder
    configFile: path.join(__dirname, 'config.json'),
    huntsFile:  path.join(__dirname, 'data', 'active_hunts.json'),
    historyFile: path.join(__dirname, 'data', 'trades_history.json'),

    // Timing
    scanIntervalMs:    60 * 1000,    
    trackerIntervalMs: 10 * 1000,    
    apiDelayMs:        60,           

    // Fleet Architecture
    maxTotalSlots: 10,
    fixedSlotCap:  10.0, 
    leverage:      1, // Starting with 1x as requested

    // Entry Filters
    maxDistancePct:    0.015,
    noiseBufferPct:    0.002, // Avoid fake signals near VWAP
    minVolume24h:      1_000_000,
    sniperDensityTrigger: 85, 

    // Risk Management & Exit
    hardStopPct: 0.05,
    takeProfitPct: 0.10,
    protectionTriggerPct: 0.05,

    vwapCacheDurationMs: 15 * 60 * 1000,
    exclude: ['USDCUSDT', 'USDPUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'DAIUSDT', 'EURUSDT', 'GBPUSDT', 'AEURUSDT', 'BTCUSDT', 'ETHUSDT']
};

let isScannerRunning = false;
let isTrackerRunning = false;
const vwapCache = new Map();

/**
 * Robust JSON loading with default values
 */
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG.configFile)) {
            const data = JSON.parse(fs.readFileSync(CONFIG.configFile, 'utf8'));
            return { ...data, enabled: data.enabled ?? true };
        }
    } catch (e) {
        console.error('[Config Error]', e.message);
    }
    return { enabled: true, totalBalance: 120.81, botToken: '', chatId: '' };
}

function loadHunts() {
    try {
        if (fs.existsSync(CONFIG.huntsFile)) {
            const content = fs.readFileSync(CONFIG.huntsFile, 'utf8').trim();
            return content ? JSON.parse(content) : [];
        }
    } catch (e) {}
    return [];
}

/**
 * Atomic JSON saving to prevent data corruption
 */
function saveHunts(hunts) { 
    try {
        const tmpFile = CONFIG.huntsFile + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(hunts, null, 2));
        fs.renameSync(tmpFile, CONFIG.huntsFile);
        return true;
    } catch (e) {
        console.error('[IO Error] Failed to save hunts:', e.message);
        return false;
    }
}

/**
 * Permanent History Accumulator
 */
function saveToHistory(trade) {
    try {
        let history = [];
        if (fs.existsSync(CONFIG.historyFile)) {
            const content = fs.readFileSync(CONFIG.historyFile, 'utf8').trim();
            history = content ? JSON.parse(content) : [];
        }
        // Avoid adding the exact same trade twice (based on symbol and entryTime)
        if (history.some(h => h.symbol === trade.symbol && h.entryTime === trade.entryTime)) return;
        
        history.push(trade);
        fs.writeFileSync(CONFIG.historyFile, JSON.stringify(history, null, 2));
    } catch (e) {
        console.error('[History Error]', e.message);
    }
}


function log(tag, emoji, msg) {
    const time = new Date().toISOString().slice(11, 19);
    console.log(`[${time}] [${tag}] ${emoji} ${msg}`);
}

async function sendTelegram(text) {
    const config = loadConfig();
    if (!config.enabled || !config.botToken || !config.chatId) return;
    const chatIds = config.chatId.split(',').map(id => id.trim());
    for (const id of chatIds) {
        try {
            await axios.post(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
                chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true
            });
        } catch (err) {}
    }
}

async function fetchKlines(symbol, interval, limit) {
    try {
        // USE FAPI (Futures)
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const res = await axios.get(url, { timeout: 10000 });
        return res.data.map(d => ({
            time: d[0], close: parseFloat(d[4]), volume: parseFloat(d[5]), quoteVolume: parseFloat(d[7])
        }));
    } catch (e) { return []; }
}

/**
 * Returns timestamp for Monday 00:00 UTC of the current week
 */
function getMondayTimestamp(ts) {
    const d = new Date(ts);
    const day = d.getUTCDay();
    const diff = (day === 0 ? 6 : day - 1);
    const mon = new Date(ts);
    mon.setUTCHours(0, 0, 0, 0);
    mon.setUTCDate(mon.getUTCDate() - diff);
    return Math.floor(mon.getTime() / 1000);
}

/**
 * Core Logic: Weekly VWAP Anchoring & Channel Calc
 */
async function calculateVwapChannel(symbol) {
    const now = Date.now();
    const cached = vwapCache.get(symbol);
    if (cached && cached.expires > now) return cached;

    const dailyKlines = await fetchKlines(symbol, '1d', 30);
    if (dailyKlines.length < 15) return null;

    const mondayTs = getMondayTimestamp(now);
    let wMax = -Infinity, wMin = Infinity;
    const dailyVwaps = dailyKlines.map(k => (k.volume > 0 ? k.quoteVolume / k.volume : k.close));

    dailyKlines.forEach((k, idx) => {
        if (idx < dailyKlines.length - 1 && getMondayTimestamp(k.time) === mondayTs) {
            if (dailyVwaps[idx] > wMax) wMax = dailyVwaps[idx];
            if (dailyVwaps[idx] < wMin) wMin = dailyVwaps[idx];
        }
    });

    const mid = dailyVwaps[dailyVwaps.length - 1];
    if (wMax === -Infinity) { wMax = mid; wMin = mid; }
    
    const k15 = await fetchKlines(symbol, '15m', 1);
    const last = k15[0]?.close || mid;

    const result = { max: wMax, min: wMin, mid, last, expires: now + CONFIG.vwapCacheDurationMs };
    vwapCache.set(symbol, result);
    return result;
}

/**
 * Entry Utility: Directional Momentum & RSI Filter
 */
async function fetchSignal5m(symbol, direction) {
    const k5 = await fetchKlines(symbol, '5m', 20);
    if (k5.length < 15) return { rsi: 50, passed: false };

    // --- VOLUME SPIKE ---
    const volumes = k5.map(k => k.volume);
    const lastVol = volumes[volumes.length - 1];
    const avgVol = volumes.slice(-5, -1).reduce((a, b) => a + b, 0) / 4;
    const volRatio = avgVol === 0 ? 100 : lastVol / avgVol;

    // --- MOMENTUM ---
    const lastClose = k5[k5.length - 1].close;
    const prevClose = k5[k5.length - 2].close;

    // 🧠 Directional momentum: Ensure candle matches entry direction
    if (direction === 'LONG') {
        if (lastClose <= prevClose) return { rsi: 50, passed: false };
    } else {
        if (lastClose >= prevClose) return { rsi: 50, passed: false };
    }

    if (volRatio < 1.5 || lastVol < 100000) {
        return { rsi: 50, passed: false };
    }

    let gains = 0, losses = 0;
    for (let i = k5.length - 14; i < k5.length; i++) {
        const diff = k5[i].close - k5[i - 1].close;
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    const rsi = losses === 0 ? 100 : 100 - (100 / (1 + (gains / losses)));
    return { rsi: Math.round(rsi), passed: true };
}

/**
 * Symbol Picker: Top 200 by Quote Volume (FUTURES)
 */
async function fetchTopSymbols(topN = 200) {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
    return res.data
        .filter(t => t.symbol.endsWith('USDT') && !CONFIG.exclude.includes(t.symbol) && parseFloat(t.quoteVolume) >= CONFIG.minVolume24h)
        .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, topN).map(t => t.symbol);
}

/**
 * MAIN SCANNER LOOP
 */
async function runHybridScanner() {
    if (isScannerRunning) return;
    isScannerRunning = true;
    try {
        const config = loadConfig();
        const balance = config.totalBalance || 120.81;
        const allHunts = loadHunts();
        let activeHunts = allHunts.filter(h => h.status === 'active');
        const used = activeHunts.reduce((s, h) => s + (h.capital || 0), 0);
        const avail = Math.max(0, balance - used);
        
        if (activeHunts.length >= CONFIG.maxTotalSlots) return;

        log('Scan', '📡', `Avail: $${avail.toFixed(2)} | Slots: ${activeHunts.length}/10`);

        // --- BTC TREND FILTER ---
        const btc = await calculateVwapChannel('BTCUSDT');
        let btcMode = 'RANGE';
        if (btc.last > btc.max) btcMode = 'BULLISH';
        else if (btc.last < btc.min) btcMode = 'BEARISH';
        
        log('Market', '₿', `BTC Status: ${btcMode} (Price: $${btc.last})`);
        
        // --- 🧪 BTC PRECISION CONFIRMATION (15m Close) ---
        const btcCandles = await fetchKlines('BTCUSDT', '15m', 2);
        if (btcCandles.length < 2) return;
        const btcPrevClose = btcCandles[0].close;

        if (btcMode === 'BULLISH' && btcPrevClose <= btc.max) {
            log('Market', '⏳', 'BTC Price > MAX but 15m Close was BELOW. Waiting for confirmation.');
            return;
        }
        if (btcMode === 'BEARISH' && btcPrevClose >= btc.min) {
            log('Market', '⏳', 'BTC Price < MIN but 15m Close was ABOVE. Waiting for confirmation.');
            return;
        }

        if (btcMode === 'RANGE') {
            log('Market', '⏳', 'BTC in Range. Skipping Altcoin entries for safety.');
            return;
        }

        const symbols = await fetchTopSymbols(200);

        for (const symbol of symbols) {
            if (activeHunts.length >= CONFIG.maxTotalSlots) break;
            if (avail < CONFIG.fixedSlotCap) break;
            if (allHunts.some(h => h.symbol === symbol && h.status === 'active')) continue;

            const v = await calculateVwapChannel(symbol);
            if (!v) continue;

            // DUAL-MODE LOGIC: TREND BREAKOUT (MID vs RANGE)
            let direction = null;

            // 🟢 LONG → mid > max + last > mid
            if (v.mid > v.max && v.last > v.mid) {
                direction = 'LONG';
            }
            // 🔴 SHORT → mid < min + last < mid
            else if (v.mid < v.min && v.last < v.mid) {
                direction = 'SHORT';
            }

            if (!direction) continue;

            // --- ⚡ BREAKOUT STRENGTH FILTER (Min 0.3%) ---
            const breakoutStrength = (v.last - (direction === 'LONG' ? v.max : v.min)) / (direction === 'LONG' ? v.max : v.min);
            if (direction === 'LONG' && breakoutStrength < 0.003) continue;
            if (direction === 'SHORT' && breakoutStrength > -0.003) continue;

            // --- BTC SYNC FILTER ---
            if (direction === 'LONG' && btcMode !== 'BULLISH') continue;
            if (direction === 'SHORT' && btcMode !== 'BEARISH') continue;

            // --- 15m CONFIRMATION (NO WICKS) ---
            const candles15m = await fetchKlines(symbol, '15m', 2);
            if (candles15m.length < 2) continue;
            const prevClose = candles15m[0].close;

            if (direction === 'LONG' && prevClose <= v.max) continue;
            if (direction === 'SHORT' && prevClose >= v.min) continue;

            const { rsi, passed } = await fetchSignal5m(symbol, direction);
            if (!passed) continue;
            
            // ADAPTIVE RSI FILTERS: Strength for Longs, Pressure for Shorts
            if (direction === 'LONG' && (rsi < 50 || rsi > 70)) continue;
            if (direction === 'SHORT' && (rsi > 50 || rsi < 30)) continue;

            // Density calculation
            const avg = (v.max + v.mid + v.min) / 3;
            const diff = (Math.abs(v.max - avg) + Math.abs(v.mid - avg) + Math.abs(v.min - avg)) / 3;
            const dens = Math.max(0, Math.round(100 * (1 - (diff / (avg * 0.02)))));
            
            const mode = dens >= CONFIG.sniperDensityTrigger ? 'Sniper' : 'Turbo';
            const capital = CONFIG.fixedSlotCap;
            
            const newHunt = { 
                symbol, direction, entryPrice: v.last, entryTime: new Date().toISOString(), 
                peakPrice: v.last, currentPrice: v.last, status: 'active', strategyId: 'vwap_futures_v3', 
                mode, density: dens, capital, tier: 1, rsi: Math.round(rsi), leverage: CONFIG.leverage
            };

            const fresh = loadHunts();
            fresh.push(newHunt);
            if (saveHunts(fresh)) {
                const icon = direction === 'LONG' ? (mode === 'Sniper' ? '🎯' : '🚀') : (mode === 'Sniper' ? '🔥' : '📉');
                log('Entry', icon, `${mode.toUpperCase()} ${direction}: ${symbol} at $${v.last}`);
                await sendTelegram(`${icon} <b>${mode.toUpperCase()} ${direction}: #${symbol}</b>\nPrice: $${v.last}\nDensity: ${dens}%\nCapital: $${capital}\nLev: ${CONFIG.leverage}x`);
                activeHunts.push(newHunt);
                await new Promise(r => setTimeout(r, CONFIG.apiDelayMs));
            }
        }
    } catch (err) { log('Scanner', '❌', err.message); } finally { isScannerRunning = false; }
}

/**
 * MAIN TRACKER LOOP: Exit & Basket Logic
 */
async function runHybridTracker() {
    if (isTrackerRunning) return;
    isTrackerRunning = true;
    try {
        const config = loadConfig();
        const hunts = loadHunts();
        let changed = false;
        const active = hunts.filter(h => h.status === 'active' && h.strategyId === 'vwap_futures_v3');
        
        let basket = [];
        let basketProfitUSD = 0;
        const now = Date.now();

        for (const hunt of active) {
            try {
                // USE FAPI
                const res = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${hunt.symbol}&interval=1m&limit=2`);
                if (!res.data[1]) continue;
                const live = parseFloat(res.data[1][4]);
                hunt.currentPrice = live;
                changed = true; // --- NEW: FORCE SYNC TO DASHBOARD ---

                // BIDIRECTIONAL PNL
                let pnl = 0;
                if (hunt.direction === 'LONG') {
                   pnl = ((live - hunt.entryPrice) / hunt.entryPrice) * 100;
                   if (live > hunt.peakPrice) hunt.peakPrice = live;
                } else {
                   pnl = ((hunt.entryPrice - live) / hunt.entryPrice) * 100; // Profit as price drops
                   if (live < hunt.peakPrice || hunt.peakPrice === hunt.entryPrice) hunt.peakPrice = live;
                }

                const ageMs = now - new Date(hunt.entryTime).getTime();
                if (ageMs > 60 * 60 * 1000 && pnl >= -1.0 && pnl <= 1.0) {
                    basket.push(hunt);
                    basketProfitUSD += hunt.capital * (pnl / 100) * (hunt.leverage || 1);
                }

                // --- SIMPLIFIED RISK LOGIC (STATIC + PROTECTION) ---
                let stopPrice = hunt.direction === 'LONG' 
                    ? hunt.entryPrice * (1 - CONFIG.hardStopPct)
                    : hunt.entryPrice * (1 + CONFIG.hardStopPct);
                
                let tpPrice = hunt.direction === 'LONG'
                    ? hunt.entryPrice * (1 + CONFIG.takeProfitPct)
                    : hunt.entryPrice * (1 - CONFIG.takeProfitPct);

                let peakGain = 0;
                if (hunt.direction === 'LONG') {
                    peakGain = (hunt.peakPrice - hunt.entryPrice) / hunt.entryPrice;
                } else {
                    peakGain = (hunt.entryPrice - hunt.peakPrice) / hunt.entryPrice;
                }

                // EXIT CHECK
                let isExit = false;
                let exitReason = '';

                // 1) HARD STOP
                if (hunt.direction === 'LONG' ? (live <= stopPrice) : (live >= stopPrice)) {
                    isExit = true;
                    exitReason = 'Static Stop Loss (-5%)';
                }
                // 2) TAKE PROFIT
                else if (hunt.direction === 'LONG' ? (live >= tpPrice) : (live <= tpPrice)) {
                    isExit = true;
                    exitReason = 'Static Take Profit (+10%)';
                }
                // 3) PROFIT PROTECTION (+5% Floor)
                else if (peakGain >= CONFIG.protectionTriggerPct && pnl <= (CONFIG.protectionTriggerPct * 100)) {
                    isExit = true;
                    exitReason = 'Profit Protection (+5% Locked)';
                }

                if (isExit) {
                    hunt.status = 'closed'; 
                    hunt.exitPrice = live; 
                    hunt.exitTime = new Date().toISOString();
                    hunt.exitReason = exitReason;
                    hunt.pnlPercent = pnl; 
                    const profit = hunt.capital * (pnl / 100) * (hunt.leverage || 1);
                    hunt.pnlUSD = profit; 
                    
                    config.totalBalance = (config.totalBalance || 120.81) + profit;
                    fs.writeFileSync(CONFIG.configFile, JSON.stringify(config, null, 2));
                    saveToHistory(hunt);
                }
                    
                    saveToHistory(hunt);
                    
                    log('Exit', '💸', `CLOSED ${hunt.direction} ${hunt.symbol} | PnL: ${pnl.toFixed(2)}% | Net: $${profit.toFixed(2)}`);
                    await sendTelegram(`🔴 <b>FUTURES EXIT: #${hunt.symbol} ${hunt.direction}</b>\nPnL: ${pnl.toFixed(2)}%\nFinal: $${profit.toFixed(2)}\nBalance: $${config.totalBalance.toFixed(2)}`);
                    changed = true;
                } else if (tier > hunt.tier) { 
                    hunt.tier = tier; 
                    changed = true; 
                    log('Tier', '💎', `TIER ${tier} UPGRADE: ${hunt.symbol}`); 
                }
            } catch (e) {}
        }

        // --- BASKET PROFIT MECHANISM ---
        // Futures Fees are on Notional (Margin * Leverage). 
        // 0.001 represents 0.1% total round-trip (standard taker fee)
        const roundTripFeeRate = 0.001; 
        const feesUSD = basket.length * CONFIG.fixedSlotCap * CONFIG.leverage * roundTripFeeRate; 
        
        if (basket.length >= 3 && basketProfitUSD > feesUSD) {
            log('Basket', '🧺', `BASKET CLOSE: ${basket.length} symbols | Net Profit: $${basketProfitUSD.toFixed(2)}`);
            await sendTelegram(`🧺 <b>BASKET PROFIT EXIT</b>\nTokens: ${basket.length}\nTotal Profit: $${basketProfitUSD.toFixed(2)}\nFees: $${feesUSD.toFixed(2)}`);
            
            const currentHunts = loadHunts();
            for (const bh of basket) {
                const target = currentHunts.find(h => h.symbol === bh.symbol && h.status === 'active');
                if (target) {
                    target.status = 'closed';
                    target.exitPrice = target.currentPrice;
                    target.exitTime = new Date().toISOString();
                    
                    let pnlPercent = 0;
                    if (target.direction === 'LONG') {
                        pnlPercent = ((target.currentPrice - target.entryPrice) / target.entryPrice) * 100;
                    } else {
                        pnlPercent = ((target.entryPrice - target.currentPrice) / target.entryPrice) * 100;
                    }

                    target.pnlPercent = pnlPercent; // --- PERSIST PNL% ---
                    const profit = target.capital * (pnlPercent / 100) * (target.leverage || 1);
                    target.pnlUSD = profit; // --- PERSIST USD ---

                    config.totalBalance = (config.totalBalance || 120.81) + profit;
                    saveToHistory(target); 
                }
            }
            fs.writeFileSync(CONFIG.configFile, JSON.stringify(config, null, 2));
            saveHunts(currentHunts);

            changed = false; // We already saved manually to avoid loop issues
        }

        if (changed) saveHunts(hunts);
    } catch (err) { log('Tracker', '❌', err.message); } finally { isTrackerRunning = false; }
}

/**
 * BOOT ENGINE
 */
log('Boot', '⚔️', 'VWAP Hybrid V2 Engine Starting (High Power mode)...');
setInterval(runHybridScanner, CONFIG.scanIntervalMs);
setInterval(runHybridTracker, CONFIG.trackerIntervalMs);

// Direct trigger on boot
runHybridScanner();
runHybridTracker();
