"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLicense = getLicense;
exports.resetLicenseCache = resetLicenseCache;
exports.isFreeTier = isFreeTier;
exports.canAccessCoin = canAccessCoin;
exports.canAccessTimeframe = canAccessTimeframe;
exports.getFundingArbLimit = getFundingArbLimit;
exports.freeGateMessage = freeGateMessage;
const FREE_COINS = new Set(['BTC', 'ETH']);
const FREE_TIMEFRAMES = new Set(['1h']);
const FREE_FUNDING_LIMIT = 5;
let cachedLicense = null;
function getLicense() {
    if (cachedLicense)
        return cachedLicense;
    const key = process.env.CQS_API_KEY || null;
    // MVP: any non-empty key = pro tier (Stripe validation in Phase 2)
    const tier = key && key.trim().length > 0 ? 'pro' : 'free';
    cachedLicense = { tier, key };
    return cachedLicense;
}
function resetLicenseCache() {
    cachedLicense = null;
}
function isFreeTier() {
    return getLicense().tier === 'free';
}
function canAccessCoin(coin) {
    if (!isFreeTier())
        return true;
    return FREE_COINS.has(coin.toUpperCase());
}
function canAccessTimeframe(timeframe) {
    if (!isFreeTier())
        return true;
    return FREE_TIMEFRAMES.has(timeframe);
}
function getFundingArbLimit(requestedLimit) {
    if (!isFreeTier())
        return requestedLimit;
    return Math.min(requestedLimit, FREE_FUNDING_LIMIT);
}
function freeGateMessage(coin, timeframe) {
    const parts = [];
    if (!FREE_COINS.has(coin.toUpperCase())) {
        parts.push(`${coin} is a Pro asset (free tier: BTC and ETH only)`);
    }
    if (!FREE_TIMEFRAMES.has(timeframe)) {
        parts.push(`${timeframe} is a Pro timeframe (free tier: 1h only)`);
    }
    if (parts.length === 0)
        return '';
    return `${parts.join('. ')}. Set CQS_API_KEY for Pro access ($29/mo).`;
}
//# sourceMappingURL=license.js.map