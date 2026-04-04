"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.closeDb = closeDb;
exports.recordSignal = recordSignal;
exports.getSignalsNeedingBackfill = getSignalsNeedingBackfill;
exports.updateOutcome = updateOutcome;
exports.getPerformanceStats = getPerformanceStats;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const DB_DIR = node_path_1.default.join(node_os_1.default.homedir(), '.crypto-quant-signal');
const DB_PATH = node_path_1.default.join(DB_DIR, 'performance.db');
let db = null;
function getDb() {
    if (db)
        return db;
    node_fs_1.default.mkdirSync(DB_DIR, { recursive: true });
    db = new better_sqlite3_1.default(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin TEXT NOT NULL,
      signal TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      timeframe TEXT NOT NULL,
      price_at_signal REAL NOT NULL,
      price_after_1h REAL,
      price_after_4h REAL,
      price_after_24h REAL,
      return_pct_1h REAL,
      return_pct_4h REAL,
      return_pct_24h REAL,
      created_at INTEGER NOT NULL
    );
  `);
    return db;
}
function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}
function recordSignal(coin, signal, confidence, timeframe, priceAtSignal) {
    const d = getDb();
    d.prepare(`
    INSERT INTO signals (coin, signal, confidence, timeframe, price_at_signal, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(coin, signal, confidence, timeframe, priceAtSignal, Math.floor(Date.now() / 1000));
}
/**
 * Find signals that need outcome backfill.
 * Returns signals older than the threshold with null outcome fields.
 */
function getSignalsNeedingBackfill(hoursAgo) {
    const d = getDb();
    const field = `price_after_${hoursAgo}h`;
    const cutoff = Math.floor(Date.now() / 1000) - hoursAgo * 3600;
    return d.prepare(`
    SELECT * FROM signals
    WHERE ${field} IS NULL AND created_at <= ?
    ORDER BY created_at ASC
    LIMIT 50
  `).all(cutoff);
}
function updateOutcome(id, field, price, returnPctField, returnPct) {
    const d = getDb();
    d.prepare(`
    UPDATE signals SET ${field} = ?, ${returnPctField} = ? WHERE id = ?
  `).run(price, returnPct, id);
}
function getPerformanceStats() {
    const d = getDb();
    const all = d.prepare(`SELECT * FROM signals ORDER BY created_at DESC`).all();
    if (all.length === 0) {
        return {
            totalSignals: 0,
            period: { from: '', to: '' },
            overall: {
                winRate: null,
                avgReturnPct: null,
                sharpeRatio: null,
                maxDrawdownPct: null,
                profitFactor: null,
            },
            bySignalType: {},
            byAsset: {},
            recentSignals: [],
        };
    }
    const oldest = all[all.length - 1];
    const newest = all[0];
    // Use 4h return as the default evaluation window
    const evaluated = all.filter(s => s.return_pct_4h !== null && s.signal !== 'HOLD');
    const wins = evaluated.filter(s => {
        if (s.signal === 'BUY')
            return (s.return_pct_4h ?? 0) > 0;
        if (s.signal === 'SELL')
            return (s.return_pct_4h ?? 0) < 0;
        return false;
    });
    const returns = evaluated.map(s => {
        const r = s.return_pct_4h ?? 0;
        return s.signal === 'SELL' ? -r : r; // For SELL signals, profit is when price drops
    });
    const winRate = evaluated.length > 0 ? wins.length / evaluated.length : null;
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
    // Sharpe ratio (annualized, assuming 4h periods)
    let sharpe = null;
    if (returns.length > 1) {
        const mean = avgReturn;
        const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
        const stdDev = Math.sqrt(variance);
        if (stdDev > 0) {
            // ~2190 4h periods per year
            sharpe = (mean / stdDev) * Math.sqrt(2190);
        }
    }
    // Max drawdown
    let peak = 0;
    let maxDD = 0;
    let cumReturn = 0;
    for (const r of returns) {
        cumReturn += r;
        if (cumReturn > peak)
            peak = cumReturn;
        const dd = peak - cumReturn;
        if (dd > maxDD)
            maxDD = dd;
    }
    // Profit factor
    const grossProfit = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
    // By signal type
    const bySignalType = {};
    for (const type of ['BUY', 'SELL', 'HOLD']) {
        const group = all.filter(s => s.signal === type);
        const evalGroup = group.filter(s => s.return_pct_4h !== null && type !== 'HOLD');
        const winsGroup = evalGroup.filter(s => {
            if (type === 'BUY')
                return (s.return_pct_4h ?? 0) > 0;
            if (type === 'SELL')
                return (s.return_pct_4h ?? 0) < 0;
            return false;
        });
        const returnsGroup = evalGroup.map(s => {
            const r = s.return_pct_4h ?? 0;
            return type === 'SELL' ? -r : r;
        });
        bySignalType[type] = {
            count: group.length,
            winRate: type === 'HOLD' ? null : (evalGroup.length > 0 ? winsGroup.length / evalGroup.length : null),
            avgReturnPct: type === 'HOLD' ? null : (returnsGroup.length > 0 ? returnsGroup.reduce((a, b) => a + b, 0) / returnsGroup.length : null),
        };
    }
    // By asset
    const coins = [...new Set(all.map(s => s.coin))];
    const byAsset = {};
    for (const coin of coins) {
        const group = all.filter(s => s.coin === coin);
        const evalGroup = group.filter(s => s.return_pct_4h !== null && s.signal !== 'HOLD');
        const winsGroup = evalGroup.filter(s => {
            if (s.signal === 'BUY')
                return (s.return_pct_4h ?? 0) > 0;
            if (s.signal === 'SELL')
                return (s.return_pct_4h ?? 0) < 0;
            return false;
        });
        const returnsGroup = evalGroup.map(s => {
            const r = s.return_pct_4h ?? 0;
            return s.signal === 'SELL' ? -r : r;
        });
        byAsset[coin] = {
            count: group.length,
            winRate: evalGroup.length > 0 ? winsGroup.length / evalGroup.length : null,
            avgReturnPct: returnsGroup.length > 0 ? returnsGroup.reduce((a, b) => a + b, 0) / returnsGroup.length : null,
        };
    }
    return {
        totalSignals: all.length,
        period: {
            from: new Date(oldest.created_at * 1000).toISOString().split('T')[0],
            to: new Date(newest.created_at * 1000).toISOString().split('T')[0],
        },
        overall: {
            winRate,
            avgReturnPct: avgReturn,
            sharpeRatio: sharpe,
            maxDrawdownPct: maxDD > 0 ? -maxDD : null,
            profitFactor,
        },
        bySignalType,
        byAsset,
        recentSignals: all.slice(0, 20),
    };
}
//# sourceMappingURL=performance-db.js.map