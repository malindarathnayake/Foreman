/**
 * Dynamic anchor selection for SmartCrusher.
 *
 * LINE-FAITHFUL TypeScript port of headroom's anchor_selector.py.
 * AnchorConfig is inlined as constants; no project config dependency.
 */
import { md5Hex16, pyJsonDumpsDefault, pyJsonDumpsSorted, } from "./pyCompat.js";
// ---------------------------------------------------------------------------
// Inlined config defaults (from AnchorConfig in headroom)
// ---------------------------------------------------------------------------
const ANCHOR_BUDGET_PCT = 0.25;
const MIN_ANCHOR_SLOTS = 3;
const MAX_ANCHOR_SLOTS = 12;
const DEFAULT_FRONT_WEIGHT = 0.5;
const DEFAULT_BACK_WEIGHT = 0.4;
const DEFAULT_MIDDLE_WEIGHT = 0.1;
const SEARCH_FRONT_WEIGHT = 0.75;
const SEARCH_BACK_WEIGHT = 0.15;
const LOGS_FRONT_WEIGHT = 0.15;
const LOGS_BACK_WEIGHT = 0.75;
const RECENCY_KEYWORDS = ["latest", "recent", "last", "newest", "current", "now"];
const HISTORICAL_KEYWORDS = ["first", "oldest", "earliest", "original", "initial", "beginning"];
const USE_INFORMATION_DENSITY = true;
const CANDIDATE_MULTIPLIER = 3;
const DEDUP_IDENTICAL_ITEMS = true;
function normalizeWeights(w) {
    const total = w.front + w.middle + w.back;
    if (total === 0)
        return { front: DEFAULT_FRONT_WEIGHT, middle: DEFAULT_MIDDLE_WEIGHT, back: DEFAULT_BACK_WEIGHT };
    return { front: w.front / total, middle: w.middle / total, back: w.back / total };
}
// ---------------------------------------------------------------------------
// compute_item_hash — md5Hex16 of pyJsonDumpsSorted
// ---------------------------------------------------------------------------
function computeItemHash(item, floatSet) {
    try {
        const content = pyJsonDumpsSorted(item, floatSet);
        return md5Hex16(content);
    }
    catch {
        return md5Hex16(String(item));
    }
}
// ---------------------------------------------------------------------------
// calculate_information_score and helpers
// ---------------------------------------------------------------------------
function _calculateValueUniqueness(item, allItems, floatSet) {
    if (allItems.length < 2)
        return 0.5;
    // Count value frequencies for each field
    const fieldValueCounts = new Map();
    for (const other of allItems) {
        if (typeof other !== "object" || other === null || Array.isArray(other))
            continue;
        const otherObj = other;
        for (const [key, value] of Object.entries(otherObj)) {
            let counter = fieldValueCounts.get(key);
            if (!counter) {
                counter = new Map();
                fieldValueCounts.set(key, counter);
            }
            let valueStr;
            try {
                valueStr = typeof value === "string" ? value : pyJsonDumpsSorted(value, floatSet);
            }
            catch {
                valueStr = String(value);
            }
            counter.set(valueStr, (counter.get(valueStr) ?? 0) + 1);
        }
    }
    const rarenessScores = [];
    const totalItems = allItems.length;
    for (const [key, value] of Object.entries(item)) {
        const counter = fieldValueCounts.get(key);
        if (!counter)
            continue;
        let valueStr;
        try {
            valueStr = typeof value === "string" ? value : pyJsonDumpsSorted(value, floatSet);
        }
        catch {
            valueStr = String(value);
        }
        const count = counter.get(valueStr) ?? 0;
        if (count > 0) {
            const frequency = count / totalItems;
            const rareness = 1.0 - frequency;
            rarenessScores.push(rareness);
        }
    }
    if (rarenessScores.length === 0)
        return 0.5;
    return rarenessScores.reduce((s, v) => s + v, 0) / rarenessScores.length;
}
function _calculateLengthScore(item, allItems, floatSet) {
    if (allItems.length < 2)
        return 0.5;
    function getLength(i) {
        try {
            return pyJsonDumpsDefault(i, floatSet).length;
        }
        catch {
            return String(i).length;
        }
    }
    const itemLength = getLength(item);
    const allLengths = allItems
        .filter((i) => typeof i === "object" && i !== null && !Array.isArray(i))
        .map(getLength);
    if (allLengths.length === 0)
        return 0.5;
    const maxLength = Math.max(...allLengths);
    const minLength = Math.min(...allLengths);
    if (maxLength === minLength)
        return 0.5;
    return (itemLength - minLength) / (maxLength - minLength);
}
function _calculateStructuralUniqueness(item, allItems) {
    if (allItems.length < 2)
        return 0.5;
    const validItems = allItems.filter((i) => typeof i === "object" && i !== null && !Array.isArray(i));
    const n = validItems.length;
    if (n < 2)
        return 0.5;
    // Count field occurrences
    const fieldCounts = new Map();
    for (const other of validItems) {
        for (const key of Object.keys(other)) {
            fieldCounts.set(key, (fieldCounts.get(key) ?? 0) + 1);
        }
    }
    const commonFields = new Set();
    const rareFields = new Set();
    for (const [k, v] of fieldCounts) {
        if (v >= n * 0.8)
            commonFields.add(k);
        if (v < n * 0.2)
            rareFields.add(k);
    }
    const itemFields = new Set(Object.keys(item));
    let hasRare = 0;
    for (const f of itemFields) {
        if (rareFields.has(f))
            hasRare++;
    }
    let missingCommon = 0;
    for (const f of commonFields) {
        if (!itemFields.has(f))
            missingCommon++;
    }
    let uniqueness = 0.0;
    if (rareFields.size > 0) {
        uniqueness += 0.5 * (hasRare / Math.max(rareFields.size, 1));
    }
    if (commonFields.size > 0) {
        uniqueness += 0.5 * (missingCommon / Math.max(commonFields.size, 1));
    }
    return Math.min(1.0, uniqueness);
}
function calculateInformationScore(item, allItems, floatSet) {
    if (!item || !allItems.length)
        return 0.0;
    if (typeof item !== "object" || item === null || Array.isArray(item))
        return 0.0;
    if (Object.keys(item).length === 0)
        return 0.0;
    const itemObj = item;
    let score = 0.0;
    let weightsUsed = 0.0;
    const uniquenessScore = _calculateValueUniqueness(itemObj, allItems, floatSet);
    score += uniquenessScore * 0.4;
    weightsUsed += 0.4;
    const lengthScore = _calculateLengthScore(itemObj, allItems, floatSet);
    score += lengthScore * 0.3;
    weightsUsed += 0.3;
    const structuralScore = _calculateStructuralUniqueness(itemObj, allItems);
    score += structuralScore * 0.3;
    weightsUsed += 0.3;
    if (weightsUsed > 0)
        score /= weightsUsed;
    return Math.min(1.0, Math.max(0.0, score));
}
// ---------------------------------------------------------------------------
// _shouldInclude
// ---------------------------------------------------------------------------
function _shouldInclude(items, idx, seenHashes, floatSet, checkOnly = false) {
    if (!DEDUP_IDENTICAL_ITEMS) {
        return true;
    }
    if (idx < 0 || idx >= items.length)
        return false;
    const item = items[idx];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
        // Non-dict items: always true (no hash recorded)
        return true;
    }
    const itemHash = computeItemHash(item, floatSet);
    if (seenHashes.has(itemHash))
        return false;
    if (!checkOnly) {
        seenHashes.add(itemHash);
    }
    return true;
}
// ---------------------------------------------------------------------------
// _selectRegionAnchors
// ---------------------------------------------------------------------------
function _selectRegionAnchors(items, startIdx, endIdx, numSlots, seenHashes, floatSet, useDensity) {
    if (numSlots <= 0 || startIdx >= endIdx)
        return new Set();
    const selected = new Set();
    const regionSize = endIdx - startIdx;
    if (!useDensity) {
        if (numSlots >= regionSize) {
            for (let idx = startIdx; idx < endIdx; idx++) {
                if (_shouldInclude(items, idx, seenHashes, floatSet)) {
                    selected.add(idx);
                }
            }
        }
        else {
            // evenly spaced — FLOAT division
            const step = regionSize / (numSlots + 1);
            for (let i = 0; i < numSlots; i++) {
                let idx = startIdx + Math.trunc((i + 1) * step);
                idx = Math.min(idx, endIdx - 1);
                if (_shouldInclude(items, idx, seenHashes, floatSet)) {
                    selected.add(idx);
                }
                else {
                    // Try adjacent offsets
                    for (const offset of [1, -1, 2, -2]) {
                        const altIdx = idx + offset;
                        if (startIdx <= altIdx && altIdx < endIdx) {
                            if (_shouldInclude(items, altIdx, seenHashes, floatSet)) {
                                selected.add(altIdx);
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
    else {
        return _selectByDensity(items, startIdx, endIdx, numSlots, seenHashes, floatSet);
    }
    return selected;
}
// ---------------------------------------------------------------------------
// _selectByDensity
// ---------------------------------------------------------------------------
function _selectByDensity(items, startIdx, endIdx, numSlots, seenHashes, floatSet) {
    const numCandidates = Math.min(numSlots * CANDIDATE_MULTIPLIER, endIdx - startIdx);
    const regionSize = endIdx - startIdx;
    const step = numCandidates > 0 ? regionSize / (numCandidates + 1) : 1;
    const candidates = [];
    const regionItems = items.slice(startIdx, endIdx);
    for (let i = 0; i < numCandidates; i++) {
        let idx = startIdx + Math.trunc((i + 1) * step);
        idx = Math.min(idx, endIdx - 1);
        // Skip if duplicate (check_only=true)
        if (!_shouldInclude(items, idx, seenHashes, floatSet, true))
            continue;
        const item = items[idx];
        let score;
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
            score = calculateInformationScore(item, regionItems, floatSet);
        }
        else {
            score = 0.5;
        }
        candidates.push([idx, score]);
    }
    // Stable sort by score descending (JS sort is stable)
    candidates.sort((a, b) => b[1] - a[1]);
    const selected = new Set();
    for (const [idx] of candidates.slice(0, numSlots)) {
        if (_shouldInclude(items, idx, seenHashes, floatSet)) {
            selected.add(idx);
        }
    }
    return selected;
}
// ---------------------------------------------------------------------------
// calculateAnchorBudget
// ---------------------------------------------------------------------------
function calculateAnchorBudget(arraySize, maxItems) {
    if (arraySize <= maxItems)
        return 0;
    const rawBudget = Math.trunc(maxItems * ANCHOR_BUDGET_PCT);
    let budget = Math.max(MIN_ANCHOR_SLOTS, rawBudget);
    budget = Math.min(MAX_ANCHOR_SLOTS, budget);
    budget = Math.min(budget, arraySize);
    return budget;
}
// ---------------------------------------------------------------------------
// getStrategyForPattern
// ---------------------------------------------------------------------------
function getStrategyForPattern(pattern) {
    switch (pattern) {
        case "search_results":
            return "front_heavy";
        case "logs":
            return "back_heavy";
        case "time_series":
            return "balanced";
        case "generic":
        default:
            return "distributed";
    }
}
// ---------------------------------------------------------------------------
// getBaseWeightsForStrategy
// ---------------------------------------------------------------------------
function getBaseWeightsForStrategy(strategy) {
    switch (strategy) {
        case "front_heavy":
            return {
                front: SEARCH_FRONT_WEIGHT,
                middle: 1.0 - SEARCH_FRONT_WEIGHT - SEARCH_BACK_WEIGHT,
                back: SEARCH_BACK_WEIGHT,
            };
        case "back_heavy":
            return {
                front: LOGS_FRONT_WEIGHT,
                middle: 1.0 - LOGS_FRONT_WEIGHT - LOGS_BACK_WEIGHT,
                back: LOGS_BACK_WEIGHT,
            };
        case "balanced":
            return { front: 0.45, middle: 0.1, back: 0.45 };
        case "distributed":
        default:
            return {
                front: DEFAULT_FRONT_WEIGHT,
                middle: DEFAULT_MIDDLE_WEIGHT,
                back: DEFAULT_BACK_WEIGHT,
            };
    }
}
// ---------------------------------------------------------------------------
// adjustWeightsForQuery
// ---------------------------------------------------------------------------
function adjustWeightsForQuery(baseWeights, query) {
    if (!query)
        return baseWeights;
    const queryLower = query.toLowerCase();
    const hasRecency = RECENCY_KEYWORDS.some((kw) => queryLower.includes(kw));
    const hasHistorical = HISTORICAL_KEYWORDS.some((kw) => queryLower.includes(kw));
    if (hasRecency && !hasHistorical) {
        const shift = 0.15;
        const newFront = Math.max(0.1, baseWeights.front - shift);
        const newBack = Math.min(0.8, baseWeights.back + shift);
        return normalizeWeights({ front: newFront, middle: baseWeights.middle, back: newBack });
    }
    else if (hasHistorical && !hasRecency) {
        const shift = 0.15;
        const newFront = Math.min(0.8, baseWeights.front + shift);
        const newBack = Math.max(0.1, baseWeights.back - shift);
        return normalizeWeights({ front: newFront, middle: baseWeights.middle, back: newBack });
    }
    return baseWeights;
}
// ---------------------------------------------------------------------------
// Public API: selectAnchors
// ---------------------------------------------------------------------------
/**
 * Select anchor indices for array compression.
 *
 * Line-faithful port of Python AnchorSelector.select_anchors().
 *
 * @param items     Array of items to compress.
 * @param maxItems  Target maximum items after compression.
 * @param pattern   Data pattern for strategy selection.
 * @param query     Optional user query for context-aware weight adjustment.
 * @param floatSet  Integral-float set from lexIntegralFloatLiterals (for hash fidelity).
 */
export function selectAnchors(items, maxItems, pattern, query, floatSet) {
    const arraySize = items.length;
    if (arraySize === 0)
        return new Set();
    if (arraySize <= maxItems) {
        // No compression needed: keep all indices
        return new Set(Array.from({ length: arraySize }, (_, i) => i));
    }
    const budget = calculateAnchorBudget(arraySize, maxItems);
    if (budget === 0)
        return new Set();
    const strategy = getStrategyForPattern(pattern);
    const baseWeights = getBaseWeightsForStrategy(strategy);
    let weights = adjustWeightsForQuery(baseWeights, query);
    weights = normalizeWeights(weights);
    // Calculate slots per region
    let frontSlots = Math.max(1, Math.trunc(budget * weights.front));
    let backSlots = Math.max(1, Math.trunc(budget * weights.back));
    let middleSlots = Math.max(0, budget - frontSlots - backSlots);
    // Ensure we don't exceed budget
    const totalSlots = frontSlots + middleSlots + backSlots;
    if (totalSlots > budget) {
        let excess = totalSlots - budget;
        const middleReduction = Math.min(middleSlots, excess);
        middleSlots -= middleReduction;
        excess -= middleReduction;
        if (excess > 0) {
            backSlots = Math.max(1, backSlots - excess);
        }
    }
    const anchors = new Set();
    const seenHashes = new Set();
    // Select front anchors
    // end_idx = min(front_slots * 2, array_size // 3)  — Python floor division
    const frontEndIdx = Math.min(frontSlots * 2, Math.trunc(arraySize / 3));
    const frontAnchors = _selectRegionAnchors(items, 0, frontEndIdx, frontSlots, seenHashes, floatSet, false);
    for (const idx of frontAnchors)
        anchors.add(idx);
    // Select back anchors
    // back_start = max(array_size - back_slots * 2, (2 * array_size) // 3)  — Python floor division
    const backStart = Math.max(arraySize - backSlots * 2, Math.trunc((2 * arraySize) / 3));
    const backAnchors = _selectRegionAnchors(items, backStart, arraySize, backSlots, seenHashes, floatSet, false);
    for (const idx of backAnchors)
        anchors.add(idx);
    // Select middle anchors
    if (middleSlots > 0) {
        const middleStart = frontAnchors.size;
        const middleEnd = arraySize - backAnchors.size;
        if (middleEnd > middleStart) {
            const middleAnchors = _selectRegionAnchors(items, middleStart, middleEnd, middleSlots, seenHashes, floatSet, USE_INFORMATION_DENSITY);
            for (const idx of middleAnchors)
                anchors.add(idx);
        }
    }
    return anchors;
}
