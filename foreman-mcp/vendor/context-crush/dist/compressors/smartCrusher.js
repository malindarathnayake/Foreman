/**
 * SmartCrusher — LINE-FAITHFUL TypeScript port of headroom's smart_crusher.py
 * (the core compressor logic, with TOIN/feedback/telemetry/Kompress omitted).
 *
 * Subsystem neutralization map (per worker brief):
 *  - TOIN, CompressionFeedback, Telemetry → OMIT
 *  - RelevanceScorer → every score = 0.0; score >= threshold blocks never fire
 *  - Kompress _compress_text_within_items → identity (returns same array ref)
 *  - Legacy CCR → replaced by OUR sentinel rule (see crushArray)
 *  - Thread locks, logging → OMIT
 */
import { sentinelFor } from "../ccr/markers.js";
import { selectAnchors } from "./anchorSelector.js";
import { computeOptimalK } from "./adaptiveSizer.js";
import { lexIntegralFloatLiterals, pyJsonStringifyCompact, pyJsonDumpsDefault, pyJsonDumpsSorted, pyNumberRepr, pyG4, pyRound, pyStr, mean, sampleVariance, sampleStdev, percentileLinear, median, md5Hex16, md5Hex8, } from "./pyCompat.js";
// ---------------------------------------------------------------------------
// Regex patterns (lines 85-97)
// ---------------------------------------------------------------------------
const _UUID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const _NUMERIC_ID_PATTERN = /\b\d{4,}\b/g;
const _HOSTNAME_PATTERN = /\b[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z]{2,})?\b/g;
const _QUOTED_STRING_PATTERN = /['"']([^'"']{1,50})['"']/g;
const _EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const _ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const _ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Error keywords for preservation guarantee (lines 768-772)
const _ERROR_KEYWORDS_FOR_PRESERVATION = [
    "error",
    "exception",
    "failed",
    "failure",
    "critical",
    "fatal",
    "crash",
    "panic",
    "abort",
    "timeout",
    "denied",
    "rejected",
];
// ---------------------------------------------------------------------------
// Query anchor extraction (lines 100-168)
// ---------------------------------------------------------------------------
export function extractQueryAnchors(text) {
    const anchors = new Set();
    if (!text)
        return anchors;
    // UUIDs
    const uuidMatches = text.matchAll(_UUID_PATTERN);
    for (const m of uuidMatches) {
        anchors.add(m[0].toLowerCase());
    }
    // Numeric IDs
    const numMatches = text.matchAll(_NUMERIC_ID_PATTERN);
    for (const m of numMatches) {
        anchors.add(m[0]);
    }
    // Hostnames
    const hostMatches = text.matchAll(_HOSTNAME_PATTERN);
    for (const m of hostMatches) {
        const lower = m[0].toLowerCase();
        if (lower !== "e.g" && lower !== "i.e" && lower !== "etc.") {
            anchors.add(lower);
        }
    }
    // Quoted strings
    const quotedMatches = text.matchAll(_QUOTED_STRING_PATTERN);
    for (const m of quotedMatches) {
        const s = m[1];
        if (s.trim().length >= 2) {
            anchors.add(s.toLowerCase());
        }
    }
    // Email addresses
    const emailMatches = text.matchAll(_EMAIL_PATTERN);
    for (const m of emailMatches) {
        anchors.add(m[0].toLowerCase());
    }
    return anchors;
}
export function itemMatchesAnchors(item, anchors, floatSet) {
    if (anchors.size === 0)
        return false;
    const itemStr = pyStr(item, floatSet).toLowerCase();
    for (const anchor of anchors) {
        if (itemStr.includes(anchor))
            return true;
    }
    return false;
}
// ---------------------------------------------------------------------------
// classifyArray (lines 369-396)
// ---------------------------------------------------------------------------
function classifyArray(items) {
    if (items.length === 0)
        return "empty";
    let hasBool = false;
    const types = new Set();
    for (const item of items) {
        if (item === null) {
            types.add("null");
        }
        else if (typeof item === "boolean") {
            hasBool = true;
            types.add("boolean");
        }
        else if (typeof item === "number") {
            types.add("number");
        }
        else if (typeof item === "string") {
            types.add("string");
        }
        else if (Array.isArray(item)) {
            types.add("array");
        }
        else if (typeof item === "object") {
            types.add("object");
        }
        else {
            types.add("other");
        }
    }
    // All bools
    if (hasBool && (types.size === 1 || (types.size === 2 && types.has("boolean"))) && items.every(i => typeof i === "boolean")) {
        return "bool_array";
    }
    if (types.size === 1 && types.has("object"))
        return "dict_array";
    if (types.size === 1 && types.has("string"))
        return "string_array";
    if (!hasBool && types.size >= 1 && !types.has("object") && !types.has("string") && !types.has("array") && !types.has("null") && !types.has("boolean") && types.has("number"))
        return "number_array";
    if (types.size === 1 && types.has("array"))
        return "nested_array";
    return "mixed_array";
}
// ---------------------------------------------------------------------------
// Statistical helpers (lines 406-524)
// ---------------------------------------------------------------------------
function isUuidFormat(value) {
    if (typeof value !== "string" || value.length !== 36)
        return false;
    const parts = value.split("-");
    if (parts.length !== 5)
        return false;
    const expectedLens = [8, 4, 4, 4, 12];
    for (let i = 0; i < 5; i++) {
        if (parts[i].length !== expectedLens[i])
            return false;
        if (!/^[0-9a-fA-F]+$/.test(parts[i]))
            return false;
    }
    return true;
}
function calculateStringEntropy(s) {
    if (!s || s.length < 2)
        return 0.0;
    const freq = {};
    for (const c of s) {
        freq[c] = (freq[c] ?? 0) + 1;
    }
    const length = s.length;
    let entropy = 0.0;
    for (const count of Object.values(freq)) {
        const p = count / length;
        if (p > 0)
            entropy -= p * Math.log2(p);
    }
    const maxEntropy = Math.log2(Math.min(Object.keys(freq).length, length));
    if (maxEntropy > 0)
        return entropy / maxEntropy;
    return 0.0;
}
function detectSequentialPattern(values, checkOrder = true) {
    if (values.length < 5)
        return false;
    const nums = [];
    let hadNonStringNumeric = false;
    for (const v of values) {
        if ((typeof v === "number") && typeof v !== "boolean") {
            nums.push(v);
            hadNonStringNumeric = true;
        }
        else if (typeof v === "string") {
            const trimmed = v.trim();
            if (/^[+-]?\d+$/.test(trimmed)) {
                nums.push(parseInt(trimmed, 10));
                // Intentionally do NOT set hadNonStringNumeric
            }
        }
    }
    if (nums.length < 5)
        return false;
    if (!hadNonStringNumeric)
        return false;
    if (nums.length < 2)
        return false;
    const sortedNums = [...nums].sort((a, b) => a - b);
    const diffs = sortedNums.slice(1).map((v, i) => v - sortedNums[i]);
    if (diffs.length === 0)
        return false;
    const avgDiff = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    if (0.5 <= avgDiff && avgDiff <= 2.0) {
        const consistentCount = diffs.filter(d => 0.5 <= d && d <= 2.0).length;
        const isSequential = consistentCount / diffs.length > 0.8;
        if (checkOrder && isSequential) {
            const ascCount = nums.slice(0, -1).filter((v, i) => v <= nums[i + 1]).length;
            return ascCount / (nums.length - 1) > 0.7;
        }
        return isSequential;
    }
    return false;
}
function detectIdFieldStatistically(stats, values) {
    if (stats.unique_ratio < 0.9)
        return [false, 0.0];
    if (stats.field_type === "string") {
        const sampleValues = values.slice(0, 20).filter(v => typeof v === "string");
        const uuidCount = sampleValues.filter(v => isUuidFormat(v)).length;
        if (sampleValues.length > 0 && uuidCount / sampleValues.length > 0.8) {
            return [true, 0.95];
        }
        if (sampleValues.length > 0) {
            const avgEntropy = sampleValues.map(v => calculateStringEntropy(v)).reduce((s, v) => s + v, 0) /
                sampleValues.length;
            if (avgEntropy > 0.7 && stats.unique_ratio > 0.95) {
                return [true, 0.8];
            }
        }
    }
    if (stats.field_type === "numeric") {
        if (detectSequentialPattern(values) && stats.unique_ratio > 0.95) {
            return [true, 0.9];
        }
        if (stats.min_val !== null && stats.max_val !== null) {
            const range = stats.max_val - stats.min_val;
            if (range > 0 && stats.unique_ratio > 0.95) {
                return [true, 0.85];
            }
        }
    }
    if (stats.unique_ratio > 0.98)
        return [true, 0.7];
    return [false, 0.0];
}
function detectScoreFieldStatistically(stats, items) {
    if (stats.field_type !== "numeric")
        return [false, 0.0];
    if (stats.min_val === null || stats.max_val === null)
        return [false, 0.0];
    let confidence = 0.0;
    const minVal = stats.min_val;
    const maxVal = stats.max_val;
    let isBounded = false;
    if (0 <= minVal && minVal <= 1 && 0 <= maxVal && maxVal <= 1) {
        isBounded = true;
        confidence += 0.4;
    }
    else if (0 <= minVal && minVal <= 10 && 0 <= maxVal && maxVal <= 10) {
        isBounded = true;
        confidence += 0.3;
    }
    else if (0 <= minVal && minVal <= 100 && 0 <= maxVal && maxVal <= 100) {
        isBounded = true;
        confidence += 0.25;
    }
    else if (-1 <= minVal && maxVal <= 1) {
        isBounded = true;
        confidence += 0.35;
    }
    if (!isBounded)
        return [false, 0.0];
    const sampleValues = items.slice(0, 50)
        .filter(item => stats.name in item)
        .map(item => item[stats.name]);
    if (detectSequentialPattern(sampleValues))
        return [false, 0.0];
    const valuesInOrder = [];
    for (const item of items) {
        if (stats.name in item) {
            const val = item[stats.name];
            if ((typeof val === "number" || typeof val === "bigint") && Number.isFinite(val)) {
                valuesInOrder.push(val);
            }
        }
    }
    if (valuesInOrder.length >= 5) {
        const numPairs = valuesInOrder.length - 1;
        const descCount = valuesInOrder.slice(0, -1).filter((v, i) => v >= valuesInOrder[i + 1]).length;
        if (numPairs > 0 && descCount / numPairs > 0.7) {
            confidence += 0.3;
        }
    }
    const floatCount = valuesInOrder
        .slice(0, 20)
        .filter(v => !Number.isInteger(v))
        .length;
    if (floatCount > valuesInOrder.slice(0, 20).length * 0.3) {
        confidence += 0.1;
    }
    return [confidence >= 0.4, Math.min(confidence, 0.95)];
}
function detectRareStatusValues(items, commonFields) {
    const outlierIndices = [];
    for (const fieldName of commonFields) {
        const values = items
            .filter(item => typeof item === "object" && item !== null && fieldName in item)
            .map(item => item[fieldName]);
        let uniqueValues;
        try {
            uniqueValues = new Set(values.filter(v => v !== null).map(v => String(v)));
        }
        catch {
            continue;
        }
        if (!(2 <= uniqueValues.size && uniqueValues.size <= 50))
            continue;
        const valueCounts = {};
        for (const v of values) {
            const key = v !== null ? String(v) : "__none__";
            valueCounts[key] = (valueCounts[key] ?? 0) + 1;
        }
        if (Object.keys(valueCounts).length === 0)
            continue;
        const total = values.length;
        const threshold = Math.ceil(total * 0.8);
        // Sort descending by count, ascending by key for tiebreak
        const sortedCounts = Object.entries(valueCounts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        let cumulative = 0;
        const topKValues = new Set();
        for (const [value, count] of sortedCounts) {
            cumulative += count;
            topKValues.add(value);
            if (cumulative >= threshold)
                break;
        }
        if (topKValues.size > 5)
            continue;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (typeof item !== "object" || item === null || !(fieldName in item))
                continue;
            const itemValue = item[fieldName] !== null ? String(item[fieldName]) : "__none__";
            if (!topKValues.has(itemValue)) {
                outlierIndices.push(i);
            }
        }
    }
    return outlierIndices;
}
function detectStructuralOutliers(items) {
    if (items.length < 5)
        return [];
    const outlierIndices = [];
    const fieldCounts = {};
    for (const item of items) {
        if (typeof item === "object" && item !== null) {
            for (const key of Object.keys(item)) {
                fieldCounts[key] = (fieldCounts[key] ?? 0) + 1;
            }
        }
    }
    const n = items.length;
    const commonFields = new Set(Object.keys(fieldCounts).filter(k => fieldCounts[k] >= n * 0.8));
    const rareFields = new Set(Object.keys(fieldCounts).filter(k => fieldCounts[k] < n * 0.2));
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (typeof item !== "object" || item === null)
            continue;
        const itemFields = new Set(Object.keys(item));
        let hasRare = false;
        for (const f of itemFields) {
            if (rareFields.has(f)) {
                hasRare = true;
                break;
            }
        }
        if (hasRare) {
            outlierIndices.push(i);
            continue;
        }
    }
    const statusOutliers = detectRareStatusValues(items, commonFields);
    outlierIndices.push(...statusOutliers);
    return [...new Set(outlierIndices)];
}
function detectErrorItemsForPreservation(items, itemStrings) {
    const errorIndices = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (typeof item !== "object" || item === null || Array.isArray(item))
            continue;
        let itemStr;
        try {
            if (itemStrings !== undefined && i < itemStrings.length) {
                itemStr = itemStrings[i].toLowerCase();
            }
            else {
                itemStr = JSON.stringify(item).toLowerCase();
            }
        }
        catch {
            continue;
        }
        for (const keyword of _ERROR_KEYWORDS_FOR_PRESERVATION) {
            if (itemStr.includes(keyword)) {
                errorIndices.push(i);
                break;
            }
        }
    }
    return errorIndices;
}
// ---------------------------------------------------------------------------
// SmartAnalyzer functions (lines 1024-1560)
// ---------------------------------------------------------------------------
function detectChangePoints(values, config, window = 5) {
    if (values.length < window * 2)
        return [];
    const overallStd = values.length > 1 ? sampleStdev(values) : 0;
    if (overallStd === 0)
        return [];
    const threshold = config.variance_threshold * overallStd;
    const changePoints = [];
    for (let i = window; i < values.length - window; i++) {
        const beforeMean = mean(values.slice(i - window, i));
        const afterMean = mean(values.slice(i, i + window));
        if (Math.abs(afterMean - beforeMean) > threshold) {
            changePoints.push(i);
        }
    }
    if (changePoints.length > 0) {
        const deduped = [changePoints[0]];
        for (const cp of changePoints.slice(1)) {
            if (cp - deduped[deduped.length - 1] > window) {
                deduped.push(cp);
            }
        }
        return deduped;
    }
    return [];
}
function analyzeField(key, items, config, floatSet) {
    const values = items
        .filter(item => typeof item === "object" && item !== null)
        .map(item => (key in item ? item[key] : null));
    const nonNullValues = values.filter(v => v !== null);
    if (nonNullValues.length === 0) {
        return {
            name: key,
            field_type: "null",
            count: values.length,
            unique_count: 0,
            unique_ratio: 0.0,
            is_constant: true,
            constant_value: null,
            min_val: null,
            max_val: null,
            mean_val: null,
            variance: null,
            change_points: [],
            avg_length: null,
            top_values: [],
        };
    }
    const firstVal = nonNullValues[0];
    let fieldType;
    if (typeof firstVal === "boolean") {
        fieldType = "boolean";
    }
    else if (typeof firstVal === "number") {
        fieldType = "numeric";
    }
    else if (typeof firstVal === "string") {
        fieldType = "string";
    }
    else if (typeof firstVal === "object" && !Array.isArray(firstVal)) {
        fieldType = "object";
    }
    else if (Array.isArray(firstVal)) {
        fieldType = "array";
    }
    else {
        fieldType = "unknown";
    }
    // Compute uniqueness using pyStr over ALL values (including None)
    const strValues = values.map(v => pyStr(v, floatSet));
    const uniqueValues = new Set(strValues);
    const uniqueCount = uniqueValues.size;
    const uniqueRatio = values.length > 0 ? uniqueCount / values.length : 0;
    const isConstant = uniqueCount === 1;
    const constantValue = isConstant ? nonNullValues[0] : null;
    const stats = {
        name: key,
        field_type: fieldType,
        count: values.length,
        unique_count: uniqueCount,
        unique_ratio: uniqueRatio,
        is_constant: isConstant,
        constant_value: constantValue,
        min_val: null,
        max_val: null,
        mean_val: null,
        variance: null,
        change_points: [],
        avg_length: null,
        top_values: [],
    };
    if (fieldType === "numeric") {
        const nums = nonNullValues.filter(v => (typeof v === "number") && Number.isFinite(v));
        if (nums.length > 0) {
            try {
                stats.min_val = Math.min(...nums);
                stats.max_val = Math.max(...nums);
                stats.mean_val = mean(nums);
                stats.variance = nums.length > 1 ? sampleVariance(nums) : 0;
                stats.change_points = detectChangePoints(nums, config);
            }
            catch {
                stats.min_val = null;
                stats.max_val = null;
                stats.mean_val = null;
                stats.variance = 0;
                stats.change_points = [];
            }
        }
    }
    else if (fieldType === "string") {
        const strs = nonNullValues.filter(v => typeof v === "string");
        if (strs.length > 0) {
            stats.avg_length = mean(strs.map(s => s.length));
            // top_values: top 5 by count desc, first-seen-order tiebreak
            const counter = new Map();
            for (const s of strs) {
                counter.set(s, (counter.get(s) ?? 0) + 1);
            }
            // Sort: count desc, first-seen order (insertion order from Map is preserved)
            const entries = [...counter.entries()];
            entries.sort((a, b) => b[1] - a[1]);
            stats.top_values = entries.slice(0, 5);
        }
    }
    return stats;
}
function detectTemporalField(fieldStats, items) {
    for (const [name, stats] of fieldStats) {
        if (stats.field_type === "string") {
            const sampleValues = items
                .slice(0, 10)
                .map(item => item[name])
                .filter(v => typeof v === "string");
            if (sampleValues.length > 0) {
                const isoCount = sampleValues.filter(v => _ISO_DATETIME_PATTERN.test(v) || _ISO_DATE_PATTERN.test(v)).length;
                if (isoCount / sampleValues.length > 0.5)
                    return true;
            }
        }
        else if (stats.field_type === "numeric") {
            // Python uses truthy check: if stats.min_val and stats.max_val
            if (stats.min_val && stats.max_val) {
                const isUnixSec = 1000000000 <= stats.min_val && stats.min_val <= 2000000000;
                const isUnixMs = 1000000000000 <= stats.min_val && stats.min_val <= 2000000000000;
                if (isUnixSec || isUnixMs)
                    return true;
            }
        }
    }
    return false;
}
function detectPattern(fieldStats, items) {
    const hasTimestamp = detectTemporalField(fieldStats, items);
    const numericFields = [...fieldStats.values()].filter(v => v.field_type === "numeric");
    const hasNumericWithVariance = numericFields.some(f => f.variance !== null && (f.variance ?? 0) > 0);
    if (hasTimestamp && hasNumericWithVariance)
        return "time_series";
    let hasMessageLike = false;
    let hasLevelLike = false;
    for (const stats of fieldStats.values()) {
        if (stats.field_type === "string") {
            if (stats.unique_ratio > 0.5 && stats.avg_length && stats.avg_length > 20) {
                hasMessageLike = true;
            }
            else if (stats.unique_ratio < 0.1 && 2 <= stats.unique_count && stats.unique_count <= 10) {
                hasLevelLike = true;
            }
        }
    }
    if (hasMessageLike && hasLevelLike)
        return "logs";
    for (const stats of fieldStats.values()) {
        const [isScore, confidence] = detectScoreFieldStatistically(stats, items);
        if (isScore && confidence >= 0.5)
            return "search_results";
    }
    return "generic";
}
function analyzeCrushability(items, fieldStats, config, floatSet) {
    const signalsPresent = [];
    const signalsAbsent = [];
    // 1. Detect ID field
    let idFieldName = null;
    let idUniqueness = 0.0;
    let idConfidence = 0.0;
    for (const [name, stats] of fieldStats) {
        const values = items
            .filter(item => typeof item === "object" && item !== null)
            .map(item => item[name]);
        const [isId, confidence] = detectIdFieldStatistically(stats, values);
        if (isId && confidence > idConfidence) {
            idFieldName = name;
            idUniqueness = stats.unique_ratio;
            idConfidence = confidence;
        }
    }
    const hasIdField = idFieldName !== null && idConfidence >= 0.7;
    // 2. Detect score field
    let hasScoreField = false;
    for (const [name, stats] of fieldStats) {
        const [isScore, confidence] = detectScoreFieldStatistically(stats, items);
        if (isScore) {
            hasScoreField = true;
            signalsPresent.push(`score_field:${name}(conf=${confidence.toFixed(2)})`);
            break;
        }
    }
    if (!hasScoreField)
        signalsAbsent.push("score_field");
    // 3. Structural outliers
    const outlierIndices = detectStructuralOutliers(items);
    const structuralOutlierCount = outlierIndices.length;
    if (structuralOutlierCount > 0) {
        signalsPresent.push(`structural_outliers:${structuralOutlierCount}`);
    }
    else {
        signalsAbsent.push("structural_outliers");
    }
    // 3b. Error keywords
    const errorKeywordIndices = detectErrorItemsForPreservation(items);
    const keywordErrorCount = errorKeywordIndices.length;
    if (keywordErrorCount > 0 && structuralOutlierCount === 0) {
        signalsPresent.push(`error_keywords:${keywordErrorCount}`);
    }
    const errorCount = Math.max(structuralOutlierCount, keywordErrorCount);
    // 4. Numeric anomalies
    const anomalyIndices = new Set();
    for (const stats of fieldStats.values()) {
        if (stats.field_type === "numeric" && stats.mean_val !== null && stats.variance) {
            const std = Math.sqrt(stats.variance);
            if (std > 0) {
                const threshold = config.variance_threshold * std;
                for (let i = 0; i < items.length; i++) {
                    const val = items[i][stats.name];
                    if (typeof val === "number") {
                        if (Math.abs(val - stats.mean_val) > threshold) {
                            anomalyIndices.add(i);
                        }
                    }
                }
            }
        }
    }
    const anomalyCount = anomalyIndices.size;
    if (anomalyCount > 0) {
        signalsPresent.push(`anomalies:${anomalyCount}`);
    }
    else {
        signalsAbsent.push("anomalies");
    }
    // 5. String uniqueness (excluding ID field)
    const stringStats = [...fieldStats.values()].filter(s => s.field_type === "string" && s.name !== idFieldName);
    const avgStringUniqueness = stringStats.length > 0
        ? mean(stringStats.map(s => s.unique_ratio))
        : 0.0;
    const nonIdNumericStats = [...fieldStats.values()].filter(s => s.field_type === "numeric" && s.name !== idFieldName);
    const avgNonIdNumericUniqueness = nonIdNumericStats.length > 0
        ? mean(nonIdNumericStats.map(s => s.unique_ratio))
        : 0.0;
    const maxUniqueness = Math.max(avgStringUniqueness, idUniqueness, 0.0);
    const nonIdContentUniqueness = Math.max(avgStringUniqueness, avgNonIdNumericUniqueness);
    // 6. Change points
    const hasChangePoints = [...fieldStats.values()].some(stats => stats.field_type === "numeric" && stats.change_points.length > 0);
    if (hasChangePoints)
        signalsPresent.push("change_points");
    const hasAnySignal = signalsPresent.length > 0;
    const base = {
        signals_present: signalsPresent,
        signals_absent: signalsAbsent,
        has_id_field: hasIdField,
        id_uniqueness: idUniqueness,
        avg_string_uniqueness: avgStringUniqueness,
        has_score_field: hasScoreField,
        error_item_count: errorCount,
        anomaly_count: anomalyCount,
    };
    // Case 0: repetitive content with unique IDs
    if (nonIdContentUniqueness < 0.1 && hasIdField) {
        signalsPresent.push("repetitive_content");
        return { crushable: true, confidence: 0.85, reason: "repetitive_content_with_ids", ...base };
    }
    // Case 1: low uniqueness
    if (maxUniqueness < 0.3) {
        return { crushable: true, confidence: 0.9, reason: "low_uniqueness_safe_to_sample", ...base };
    }
    // Case 2: high uniqueness + ID + no signal
    if (hasIdField && maxUniqueness > 0.8 && !hasAnySignal) {
        return { crushable: false, confidence: 0.85, reason: "unique_entities_no_signal", ...base };
    }
    // Case 3: high uniqueness + has signal
    if (maxUniqueness > 0.8 && hasAnySignal) {
        return { crushable: true, confidence: 0.7, reason: "unique_entities_with_signal", ...base };
    }
    // Case 4: medium uniqueness + no signal
    if (!hasAnySignal) {
        return { crushable: false, confidence: 0.6, reason: "medium_uniqueness_no_signal", ...base };
    }
    // Case 5: medium uniqueness + has signal
    return { crushable: true, confidence: 0.5, reason: "medium_uniqueness_with_signal", ...base };
}
function selectStrategy(fieldStats, pattern, itemCount, crushability, config) {
    if (itemCount < config.min_items_to_analyze)
        return "none";
    if (crushability !== null && !crushability.crushable)
        return "skip";
    if (pattern === "time_series") {
        const numericFields = [...fieldStats.values()].filter(v => v.field_type === "numeric");
        const hasChangePoints = numericFields.some(f => f.change_points.length > 0);
        if (hasChangePoints)
            return "time_series";
    }
    if (pattern === "logs") {
        // Python: next((v for k, v in field_stats.items() if "message" in k.lower()), None)
        // — only the FIRST message-like field (sorted-key order) is consulted.
        let messageField = null;
        for (const [k, v] of fieldStats) {
            if (k.toLowerCase().includes("message")) {
                messageField = v;
                break;
            }
        }
        if (messageField !== null && messageField.unique_ratio < 0.5) {
            return "cluster";
        }
    }
    if (pattern === "search_results")
        return "top_n";
    return "smart_sample";
}
function estimateReduction(fieldStats, strategy, itemCount) {
    if (strategy === "none")
        return 0.0;
    const constantRatio = fieldStats.size > 0
        ? [...fieldStats.values()].filter(v => v.is_constant).length / fieldStats.size
        : 0;
    const baseReduction = {
        time_series: 0.7,
        cluster: 0.8,
        top_n: 0.6,
        smart_sample: 0.5,
    };
    const base = baseReduction[strategy] ?? 0.3;
    return Math.min(base + constantRatio * 0.2, 0.95);
}
function analyzeArray(items, config, floatSet) {
    const dicts = items;
    if (!items.length || typeof items[0] !== "object" || items[0] === null || Array.isArray(items[0])) {
        return {
            item_count: items.length,
            field_stats: new Map(),
            detected_pattern: "generic",
            recommended_strategy: "none",
            constant_fields: {},
            estimated_reduction: 0.0,
            crushability: null,
        };
    }
    // Collect all keys in sorted order
    const allKeys = new Set();
    for (const item of dicts) {
        if (typeof item === "object" && item !== null) {
            for (const k of Object.keys(item))
                allKeys.add(k);
        }
    }
    const fieldStats = new Map();
    for (const key of [...allKeys].sort()) {
        fieldStats.set(key, analyzeField(key, dicts, config, floatSet));
    }
    const pattern = detectPattern(fieldStats, dicts);
    const constantFields = {};
    for (const [k, v] of fieldStats) {
        if (v.is_constant)
            constantFields[k] = v.constant_value;
    }
    const crushability = analyzeCrushability(dicts, fieldStats, config, floatSet);
    const strategy = selectStrategy(fieldStats, pattern, items.length, crushability, config);
    const reduction = strategy === "skip" ? 0.0 : estimateReduction(fieldStats, strategy, items.length);
    return {
        item_count: items.length,
        field_stats: fieldStats,
        detected_pattern: pattern,
        recommended_strategy: strategy,
        constant_fields: constantFields,
        estimated_reduction: reduction,
        crushability,
    };
}
// ---------------------------------------------------------------------------
// Index management (lines 1792-2107)
// ---------------------------------------------------------------------------
function deduplicateIndicesByContent(keepIndices, items, floatSet) {
    if (keepIndices.size === 0)
        return keepIndices;
    const seenHashes = new Map();
    for (const idx of [...keepIndices].sort((a, b) => a - b)) {
        if (idx < 0 || idx >= items.length)
            continue;
        const item = items[idx];
        let itemHash;
        try {
            if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                const content = pyJsonDumpsSorted(item, floatSet);
                itemHash = md5Hex16(content);
            }
            else {
                itemHash = md5Hex16(String(item));
            }
        }
        catch {
            itemHash = `__idx_${idx}__`;
        }
        if (!seenHashes.has(itemHash)) {
            seenHashes.set(itemHash, idx);
        }
    }
    return new Set(seenHashes.values());
}
function fillRemainingSlots(keepIndices, items, n, effectiveMax, floatSet) {
    const remainingSlots = effectiveMax - keepIndices.size;
    if (remainingSlots <= 0)
        return keepIndices;
    const seenHashes = new Set();
    for (const idx of keepIndices) {
        if (idx >= 0 && idx < n) {
            const item = items[idx];
            try {
                let content;
                if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                    content = pyJsonDumpsSorted(item, floatSet);
                }
                else {
                    content = String(item);
                }
                seenHashes.add(md5Hex16(content));
            }
            catch {
                // skip
            }
        }
    }
    const candidates = Array.from({ length: n }, (_, i) => i).filter(i => !keepIndices.has(i));
    if (candidates.length === 0)
        return keepIndices;
    const result = new Set(keepIndices);
    let added = 0;
    const step = Math.max(1, Math.trunc(candidates.length / (remainingSlots + 1)));
    outer: for (let startOffset = 0; startOffset < step; startOffset++) {
        if (added >= remainingSlots)
            break;
        for (let i = startOffset; i < candidates.length; i += step) {
            if (added >= remainingSlots)
                break outer;
            const idx = candidates[i];
            const item = items[idx];
            let itemHash;
            try {
                let content;
                if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                    content = pyJsonDumpsSorted(item, floatSet);
                }
                else {
                    content = String(item);
                }
                itemHash = md5Hex16(content);
            }
            catch {
                itemHash = `__idx_${idx}__`;
            }
            if (!seenHashes.has(itemHash)) {
                result.add(idx);
                seenHashes.add(itemHash);
                added++;
            }
        }
    }
    return result;
}
function prioritizeIndices(keepIndices, items, n, analysis, maxItems, config, floatSet) {
    const effectiveMax = maxItems;
    if (config.dedup_identical_items) {
        keepIndices = deduplicateIndicesByContent(keepIndices, items, floatSet);
    }
    if (keepIndices.size < effectiveMax && keepIndices.size < n) {
        keepIndices = fillRemainingSlots(keepIndices, items, n, effectiveMax, floatSet);
    }
    if (keepIndices.size <= effectiveMax)
        return keepIndices;
    // Build priority sets
    const errorIndices = new Set(detectErrorItemsForPreservation(items));
    const outlierIndices = new Set(detectStructuralOutliers(items));
    const anomalyIndices = new Set();
    if (analysis && analysis.field_stats) {
        for (const [fieldName, stats] of analysis.field_stats) {
            if (stats.field_type === "numeric" && stats.mean_val !== null && stats.variance) {
                const std = Math.sqrt(stats.variance);
                if (std > 0) {
                    const threshold = config.variance_threshold * std;
                    for (let i = 0; i < items.length; i++) {
                        const item = items[i];
                        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                            const val = item[fieldName];
                            if (typeof val === "number") {
                                if (Math.abs(val - stats.mean_val) > threshold) {
                                    anomalyIndices.add(i);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    const prioritized = new Set([...errorIndices, ...outlierIndices, ...anomalyIndices]);
    let remainingSlots = effectiveMax - prioritized.size;
    if (remainingSlots > 0) {
        // First 3 items
        for (let i = 0; i < Math.min(3, n); i++) {
            if (!prioritized.has(i) && remainingSlots > 0) {
                prioritized.add(i);
                remainingSlots--;
            }
        }
        // Last 2 items
        for (let i = Math.max(0, n - 2); i < n; i++) {
            if (!prioritized.has(i) && remainingSlots > 0) {
                prioritized.add(i);
                remainingSlots--;
            }
        }
    }
    if (remainingSlots > 0) {
        const otherIndices = [...keepIndices].filter(i => !prioritized.has(i)).sort((a, b) => a - b);
        for (const i of otherIndices) {
            if (remainingSlots <= 0)
                break;
            prioritized.add(i);
            remainingSlots--;
        }
    }
    return prioritized;
}
// ---------------------------------------------------------------------------
// Plan creation helpers
// ---------------------------------------------------------------------------
function patternFor(strategy) {
    switch (strategy) {
        case "time_series": return "time_series";
        case "top_n": return "search_results";
        case "cluster": return "logs";
        default: return "generic";
    }
}
function planTimeSeries(analysis, items, query, adaptiveK, itemStrings, config, floatSet) {
    const effectiveMax = adaptiveK;
    const n = items.length;
    const keepIndices = new Set();
    const anchorIndices = selectAnchors(items, effectiveMax, "time_series", query || null, floatSet);
    for (const idx of anchorIndices)
        keepIndices.add(idx);
    for (const stats of analysis.field_stats.values()) {
        if (stats.change_points.length > 0) {
            for (const cp of stats.change_points) {
                for (let offset = -2; offset <= 2; offset++) {
                    const idx = cp + offset;
                    if (0 <= idx && idx < n)
                        keepIndices.add(idx);
                }
            }
        }
    }
    const outlierIdxs = detectStructuralOutliers(items);
    for (const idx of outlierIdxs)
        keepIndices.add(idx);
    const errorIdxs = detectErrorItemsForPreservation(items);
    for (const idx of errorIdxs)
        keepIndices.add(idx);
    if (query) {
        const anchors = extractQueryAnchors(query);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                if (itemMatchesAnchors(item, anchors, floatSet)) {
                    keepIndices.add(i);
                }
            }
        }
        // Relevance scorer: no-op (all scores 0.0)
    }
    const prioritized = prioritizeIndices(keepIndices, items, n, analysis, effectiveMax, config, floatSet);
    return {
        strategy: "time_series",
        keep_indices: [...prioritized].sort((a, b) => a - b),
        constant_fields: config.factor_out_constants ? analysis.constant_fields : {},
        cluster_field: null,
        sort_field: null,
        keep_count: 10,
    };
}
function planClusterSample(analysis, items, query, adaptiveK, itemStrings, config, floatSet) {
    const effectiveMax = adaptiveK;
    const n = items.length;
    const keepIndices = new Set();
    const anchorIndices = selectAnchors(items, effectiveMax, "logs", query || null, floatSet);
    for (const idx of anchorIndices)
        keepIndices.add(idx);
    const outlierIdxs = detectStructuralOutliers(items);
    for (const idx of outlierIdxs)
        keepIndices.add(idx);
    const errorIdxs = detectErrorItemsForPreservation(items);
    for (const idx of errorIdxs)
        keepIndices.add(idx);
    // Cluster by message-like field
    let messageField = null;
    let maxUniqueness = 0.0;
    for (const [name, stats] of analysis.field_stats) {
        if (stats.field_type === "string" && stats.unique_ratio > maxUniqueness) {
            if (stats.unique_ratio > 0.3) {
                messageField = name;
                maxUniqueness = stats.unique_ratio;
            }
        }
    }
    if (messageField !== null) {
        const clusters = new Map();
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                const raw = messageField in item
                    ? item[messageField]
                    : "";
                const msg = pyStr(raw, floatSet).slice(0, 50);
                const msgHash = md5Hex8(msg);
                if (!clusters.has(msgHash))
                    clusters.set(msgHash, []);
                clusters.get(msgHash).push(i);
            }
        }
        for (const indices of clusters.values()) {
            for (const idx of indices.slice(0, 2)) {
                keepIndices.add(idx);
            }
        }
    }
    if (query) {
        const anchors = extractQueryAnchors(query);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                if (itemMatchesAnchors(item, anchors, floatSet)) {
                    keepIndices.add(i);
                }
            }
        }
        // Relevance: no-op
    }
    const prioritized = prioritizeIndices(keepIndices, items, n, analysis, effectiveMax, config, floatSet);
    return {
        strategy: "cluster",
        keep_indices: [...prioritized].sort((a, b) => a - b),
        constant_fields: config.factor_out_constants ? analysis.constant_fields : {},
        cluster_field: messageField,
        sort_field: null,
        keep_count: 10,
    };
}
function planTopN(analysis, items, query, adaptiveK, itemStrings, config, floatSet) {
    const effectiveMax = adaptiveK;
    // Find score field using highest-confidence (strict >)
    let scoreField = null;
    let maxConfidence = 0.0;
    for (const [name, stats] of analysis.field_stats) {
        const [isScore, confidence] = detectScoreFieldStatistically(stats, items);
        if (isScore && confidence > maxConfidence) {
            scoreField = name;
            maxConfidence = confidence;
        }
    }
    if (!scoreField) {
        // Fall through to smart_sample
        return planSmartSample(analysis, items, query, adaptiveK, itemStrings, config, floatSet);
    }
    const keepIndices = new Set();
    // Top N by score
    const scoredItems = items.map((item, i) => {
        const v = typeof item === "object" && item !== null && !Array.isArray(item)
            ? item[scoreField] ?? 0
            : 0;
        return [i, typeof v === "number" ? v : 0];
    });
    scoredItems.sort((a, b) => b[1] - a[1]);
    const topCount = Math.max(0, effectiveMax - 3);
    for (const [idx] of scoredItems.slice(0, topCount)) {
        keepIndices.add(idx);
    }
    const outlierIdxs = detectStructuralOutliers(items);
    for (const idx of outlierIdxs)
        keepIndices.add(idx);
    const errorIdxs = detectErrorItemsForPreservation(items);
    for (const idx of errorIdxs)
        keepIndices.add(idx);
    if (query) {
        const anchors = extractQueryAnchors(query);
        for (let i = 0; i < items.length; i++) {
            if (!keepIndices.has(i)) {
                const item = items[i];
                if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                    if (itemMatchesAnchors(item, anchors, floatSet)) {
                        keepIndices.add(i);
                    }
                }
            }
        }
        // Relevance: no-op
    }
    return {
        strategy: "top_n",
        keep_indices: [...keepIndices].sort((a, b) => a - b),
        constant_fields: config.factor_out_constants ? analysis.constant_fields : {},
        cluster_field: null,
        sort_field: scoreField,
        keep_count: keepIndices.size,
    };
}
function planSmartSample(analysis, items, query, adaptiveK, itemStrings, config, floatSet) {
    const effectiveMax = adaptiveK;
    const n = items.length;
    const keepIndices = new Set();
    const anchorIndices = selectAnchors(items, effectiveMax, "generic", query || null, floatSet);
    for (const idx of anchorIndices)
        keepIndices.add(idx);
    const outlierIdxs = detectStructuralOutliers(items);
    for (const idx of outlierIdxs)
        keepIndices.add(idx);
    const errorIdxs = detectErrorItemsForPreservation(items);
    for (const idx of errorIdxs)
        keepIndices.add(idx);
    // Anomalous numeric items
    for (const [name, stats] of analysis.field_stats) {
        if (stats.field_type === "numeric" && stats.mean_val !== null && stats.variance) {
            const std = Math.sqrt(stats.variance);
            if (std > 0) {
                const threshold = config.variance_threshold * std;
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                        const val = item[name];
                        if (typeof val === "number") {
                            if (Math.abs(val - stats.mean_val) > threshold)
                                keepIndices.add(i);
                        }
                    }
                }
            }
        }
    }
    // Change point windows
    if (config.preserve_change_points) {
        for (const stats of analysis.field_stats.values()) {
            if (stats.change_points.length > 0) {
                for (const cp of stats.change_points) {
                    for (let offset = -1; offset <= 1; offset++) {
                        const idx = cp + offset;
                        if (0 <= idx && idx < n)
                            keepIndices.add(idx);
                    }
                }
            }
        }
    }
    if (query) {
        const anchors = extractQueryAnchors(query);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                if (itemMatchesAnchors(item, anchors, floatSet))
                    keepIndices.add(i);
            }
        }
        // Relevance: no-op
    }
    const prioritized = prioritizeIndices(keepIndices, items, n, analysis, effectiveMax, config, floatSet);
    return {
        strategy: "smart_sample",
        keep_indices: [...prioritized].sort((a, b) => a - b),
        constant_fields: config.factor_out_constants ? analysis.constant_fields : {},
        cluster_field: null,
        sort_field: null,
        keep_count: 10,
    };
}
function createPlan(analysis, items, query, adaptiveK, itemStrings, config, floatSet) {
    const strategy = analysis.recommended_strategy;
    if (strategy === "skip") {
        return {
            strategy: "skip",
            keep_indices: Array.from({ length: items.length }, (_, i) => i),
            constant_fields: {},
            cluster_field: null,
            sort_field: null,
            keep_count: items.length,
        };
    }
    if (strategy === "time_series") {
        return planTimeSeries(analysis, items, query, adaptiveK, itemStrings, config, floatSet);
    }
    else if (strategy === "cluster") {
        return planClusterSample(analysis, items, query, adaptiveK, itemStrings, config, floatSet);
    }
    else if (strategy === "top_n") {
        return planTopN(analysis, items, query, adaptiveK, itemStrings, config, floatSet);
    }
    else {
        return planSmartSample(analysis, items, query, adaptiveK, itemStrings, config, floatSet);
    }
}
function executePlan(plan, items) {
    const result = [];
    for (const idx of [...plan.keep_indices].sort((a, b) => a - b)) {
        if (idx >= 0 && idx < items.length) {
            const item = items[idx];
            if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                result.push({ ...item });
            }
            else {
                result.push(item);
            }
        }
    }
    return result;
}
function crushArray(items, query, toolName, bias, config, floatSet, store) {
    const itemStrings = items.map(i => pyJsonDumpsDefault(i, floatSet));
    const adaptiveK = computeOptimalK(itemStrings, bias, 3, config.max_items_after_crush || null);
    if (items.length <= adaptiveK) {
        // Kompress identity: _compress_text_within_items returns same ref → always this branch
        return { rows: items, strategy: "none:adaptive_at_limit" };
    }
    const effectiveMaxItems = adaptiveK;
    const analysis = analyzeArray(items, config, floatSet);
    if (analysis.recommended_strategy === "skip") {
        const reason = analysis.crushability
            ? `skip:${analysis.crushability.reason}`
            : "";
        return { rows: items, strategy: reason };
    }
    const plan = createPlan(analysis, items, query, effectiveMaxItems, itemStrings, config, floatSet);
    const result = executePlan(plan, items);
    // OUR CCR sentinel rule
    if (store != null && result.length < items.length) {
        const keptSet = new Set(plan.keep_indices);
        const droppedRows = [];
        for (let i = 0; i < items.length; i++) {
            if (!keptSet.has(i))
                droppedRows.push(items[i]);
        }
        const payload = pyJsonStringifyCompact(droppedRows, floatSet);
        let ref = null;
        try {
            ref = store.put(payload, {
                toolName: toolName ?? "",
                strategy: "smart_crusher",
            });
        }
        catch {
            ref = null;
        }
        if (ref === null) {
            // Fail-open: return original items unchanged
            return { rows: items, strategy: "skip:ccr_store_failed" };
        }
        const droppedCount = items.length - result.length;
        const sentinel = sentinelFor(ref.hash, droppedCount);
        return {
            rows: result,
            strategy: analysis.recommended_strategy,
            sentinel,
        };
    }
    return { rows: result, strategy: analysis.recommended_strategy };
}
// ---------------------------------------------------------------------------
// computeKSplit (lines 2764-2802)
// ---------------------------------------------------------------------------
function computeKSplit(items, bias, config, floatSet, itemStrings) {
    const strs = itemStrings ?? items.map(i => pyJsonDumpsDefault(i, floatSet));
    const kTotal = computeOptimalK(strs, bias, 3, config.max_items_after_crush || null);
    let kFirst = Math.max(1, pyRound(kTotal * config.first_fraction));
    kFirst = Math.min(kFirst, kTotal);
    let kLast = Math.max(1, pyRound(kTotal * config.last_fraction));
    kLast = Math.min(kLast, Math.max(0, kTotal - kFirst));
    const kImportance = Math.max(0, kTotal - kFirst - kLast);
    return [kTotal, kFirst, kLast, kImportance];
}
// ---------------------------------------------------------------------------
// crushStringArray (lines 2804-2885)
// ---------------------------------------------------------------------------
function crushStringArray(items, bias, config, floatSet) {
    const n = items.length;
    if (n <= 8)
        return [items, "string:passthrough"];
    const [kTotal, kFirst, kLast] = computeKSplit(items, bias, config, floatSet);
    // Error indices
    const errorIndices = new Set();
    for (let i = 0; i < n; i++) {
        const sLower = items[i].toLowerCase();
        for (const kw of _ERROR_KEYWORDS_FOR_PRESERVATION) {
            if (sLower.includes(kw)) {
                errorIndices.add(i);
                break;
            }
        }
    }
    // Anomaly indices (length outliers)
    const lengths = items.map(s => s.length);
    const anomalyIndices = new Set();
    if (lengths.length > 1) {
        const meanLen = mean(lengths);
        const stdLen = sampleStdev(lengths);
        for (let i = 0; i < n; i++) {
            if (stdLen > 0 && Math.abs(lengths[i] - meanLen) > config.variance_threshold * stdLen) {
                anomalyIndices.add(i);
            }
        }
    }
    const firstIndices = new Set(Array.from({ length: Math.min(kFirst, n) }, (_, i) => i));
    const lastIndices = new Set(Array.from({ length: Math.min(kLast, n) }, (_, i) => Math.max(0, n - kLast) + i));
    let keepIndices = new Set([
        ...errorIndices,
        ...anomalyIndices,
        ...firstIndices,
        ...lastIndices,
    ]);
    // Dedup: prefill seen_strings from sorted keep
    const seenStrings = new Set();
    let dedupCount = 0;
    for (const i of [...keepIndices].sort((a, b) => a - b)) {
        seenStrings.add(items[i]);
    }
    // Fill remaining budget
    const remainingBudget = Math.max(0, kTotal - keepIndices.size);
    if (remainingBudget > 0) {
        const stride = Math.max(1, Math.trunc((n - 1) / (remainingBudget + 1)));
        for (let i = 0; i < n; i += stride) {
            if (keepIndices.size >= kTotal + errorIndices.size + anomalyIndices.size)
                break;
            if (!keepIndices.has(i)) {
                if (!seenStrings.has(items[i])) {
                    keepIndices.add(i);
                    seenStrings.add(items[i]);
                }
                else {
                    dedupCount++;
                }
            }
        }
    }
    const result = [...keepIndices].sort((a, b) => a - b).map(i => items[i]);
    let strategyStr = `string:adaptive(${n}->${result.length}`;
    if (dedupCount)
        strategyStr += `,dedup=${dedupCount}`;
    if (errorIndices.size)
        strategyStr += `,errors=${errorIndices.size}`;
    strategyStr += ")";
    return [result, strategyStr];
}
// ---------------------------------------------------------------------------
// crushNumberArray (lines 2887-2993)
// ---------------------------------------------------------------------------
function crushNumberArray(items, bias, config, floatSet) {
    const n = items.length;
    if (n <= 8)
        return [items, "number:passthrough"];
    const finite = items.filter(x => typeof x === "number" && Number.isFinite(x));
    if (finite.length === 0)
        return [items, "number:no_finite"];
    const [kTotal, kFirst, kLast] = computeKSplit(items, bias, config, floatSet);
    const meanVal = mean(finite);
    const medianVal = median(finite);
    const stdVal = finite.length > 1 ? sampleStdev(finite) : 0.0;
    const sortedFinite = [...finite].sort((a, b) => a - b);
    const p25 = percentileLinear(sortedFinite, 0.25);
    const p75 = percentileLinear(sortedFinite, 0.75);
    const minVal = Math.min(...finite);
    const maxVal = Math.max(...finite);
    // Outliers
    const outlierIndices = new Set();
    if (stdVal > 0) {
        for (let i = 0; i < n; i++) {
            const val = items[i];
            if (typeof val === "number" && Number.isFinite(val)) {
                if (Math.abs(val - meanVal) > config.variance_threshold * stdVal) {
                    outlierIndices.add(i);
                }
            }
        }
    }
    // Change points (over RAW items with finite filtering inside)
    const changeIndices = new Set();
    if (config.preserve_change_points && n > 10) {
        const window = 5;
        for (let i = window; i < n - window; i++) {
            const left = [];
            const right = [];
            for (let j = i - window; j < i; j++) {
                const v = items[j];
                if (typeof v === "number" && Number.isFinite(v))
                    left.push(v);
            }
            for (let j = i; j < i + window; j++) {
                const v = items[j];
                if (typeof v === "number" && Number.isFinite(v))
                    right.push(v);
            }
            if (left.length > 0 && right.length > 0) {
                const leftMean = mean(left);
                const rightMean = mean(right);
                if (stdVal > 0 && Math.abs(rightMean - leftMean) > config.variance_threshold * stdVal) {
                    changeIndices.add(i);
                }
            }
        }
    }
    const firstIndices = new Set(Array.from({ length: Math.min(kFirst, n) }, (_, i) => i));
    const lastIndices = new Set(Array.from({ length: Math.min(kLast, n) }, (_, i) => Math.max(0, n - kLast) + i));
    let keepIndices = new Set([
        ...outlierIndices,
        ...changeIndices,
        ...firstIndices,
        ...lastIndices,
    ]);
    // Fill remaining budget
    const remainingBudget = Math.max(0, kTotal - keepIndices.size);
    if (remainingBudget > 0) {
        const stride = Math.max(1, Math.trunc((n - 1) / (remainingBudget + 1)));
        for (let i = 0; i < n; i += stride) {
            if (keepIndices.size >= kTotal + outlierIndices.size)
                break;
            if (!keepIndices.has(i))
                keepIndices.add(i);
        }
    }
    const keptValues = [...keepIndices].sort((a, b) => a - b).map(i => items[i]);
    // min/max use pyNumberRepr (raw finite values); mean/median/stddev/p25/p75 use pyG4
    let strategyStr = `number:adaptive(${n}->${keptValues.length}` +
        `,min=${pyNumberRepr(minVal, floatSet)},max=${pyNumberRepr(maxVal, floatSet)}` +
        `,mean=${pyG4(meanVal)},median=${pyG4(medianVal)}` +
        `,stddev=${pyG4(stdVal)},p25=${pyG4(p25)},p75=${pyG4(p75)}`;
    if (outlierIndices.size)
        strategyStr += `,outliers=${outlierIndices.size}`;
    if (changeIndices.size)
        strategyStr += `,change_points=${changeIndices.size}`;
    strategyStr += ")";
    return [keptValues, strategyStr];
}
// ---------------------------------------------------------------------------
// crushMixedArray (lines 2995-3094)
// ---------------------------------------------------------------------------
function crushMixedArray(items, query, toolName, bias, config, floatSet) {
    const n = items.length;
    if (n <= 8)
        return [items, "mixed:passthrough"];
    // Group items by type (Python order: dict, str, bool, number, list, none, other)
    // CAUTION: bool BEFORE number; null explicit
    const groups = new Map();
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let key;
        if (item === null) {
            key = "none";
        }
        else if (typeof item === "boolean") {
            key = "bool";
        }
        else if (typeof item === "object" && !Array.isArray(item)) {
            key = "dict";
        }
        else if (typeof item === "string") {
            key = "str";
        }
        else if (typeof item === "number") {
            key = "number";
        }
        else if (Array.isArray(item)) {
            key = "list";
        }
        else {
            key = "other";
        }
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push([i, item]);
    }
    const keepIndices = new Set();
    const strategyParts = [];
    for (const [typeKey, groupItems] of groups) {
        const indices = groupItems.map(([idx]) => idx);
        const values = groupItems.map(([, val]) => val);
        if (values.length < config.min_items_to_analyze) {
            for (const idx of indices)
                keepIndices.add(idx);
            continue;
        }
        if (typeKey === "dict") {
            // Use crushArray WITHOUT store (no sentinels inside mixed arrays)
            const { rows: crushed, strategy: _s } = crushArray(values, query, toolName, bias, config, floatSet, null);
            const crushedSet = new Set(crushed.map(c => pyJsonDumpsSorted(c, floatSet)));
            for (const [idx, val] of groupItems) {
                if (crushedSet.has(pyJsonDumpsSorted(val, floatSet)))
                    keepIndices.add(idx);
            }
            strategyParts.push(`dict:${values.length}->${crushed.length}`);
        }
        else if (typeKey === "str") {
            const [crushed] = crushStringArray(values, bias, config, floatSet);
            const crushedSet = new Set(crushed);
            for (const [idx, val] of groupItems) {
                if (crushedSet.has(val))
                    keepIndices.add(idx);
            }
            strategyParts.push(`str:${values.length}->${crushed.length}`);
        }
        else if (typeKey === "number") {
            const [kTotal, kFirst, kLast] = computeKSplit(values, bias, config, floatSet);
            const firstIdx = new Set(indices.slice(0, kFirst));
            const lastIdx = new Set(indices.slice(-kLast));
            for (const idx of [...firstIdx, ...lastIdx])
                keepIndices.add(idx);
            const finiteVals = values.filter(v => typeof v === "number" && Number.isFinite(v));
            if (finiteVals.length > 1) {
                const meanV = mean(finiteVals);
                const stdV = sampleStdev(finiteVals);
                if (stdV > 0) {
                    for (const [idx, val] of groupItems) {
                        if (typeof val === "number" && Number.isFinite(val)) {
                            if (Math.abs(val - meanV) > config.variance_threshold * stdV)
                                keepIndices.add(idx);
                        }
                    }
                }
            }
            strategyParts.push(`num:${values.length}`);
        }
        else {
            // list, bool, none, other — keep all
            for (const idx of indices)
                keepIndices.add(idx);
        }
    }
    const result = [...keepIndices].sort((a, b) => a - b).map(i => items[i]);
    const strategy = `mixed:adaptive(${n}->${result.length},${strategyParts.join(",")})`;
    return [result, strategy];
}
// ---------------------------------------------------------------------------
// crushObject (lines 3096-3196)
// ---------------------------------------------------------------------------
function crushObject(obj, bias, config, floatSet) {
    const n = Object.keys(obj).length;
    if (n <= 8)
        return [obj, "object:passthrough"];
    const keys = Object.keys(obj);
    const kvTokens = [];
    let totalTokens = 0;
    for (const key of keys) {
        const valStr = pyJsonDumpsDefault(obj[key], floatSet);
        const tokens = Math.trunc(valStr.length / 4) + Math.trunc(key.length / 4) + 2;
        kvTokens.push([key, tokens]);
        totalTokens += tokens;
    }
    if (totalTokens < config.min_tokens_to_crush)
        return [obj, "object:passthrough"];
    const kvStrings = keys.map(k => `${k}: ${pyJsonDumpsDefault(obj[k], floatSet)}`);
    const kTotal = computeOptimalK(kvStrings, bias, 3, config.max_items_after_crush || null);
    if (kTotal >= n)
        return [obj, "object:passthrough"];
    const keepKeys = new Set();
    // Error-containing values
    for (const key of keys) {
        const valStr = pyJsonDumpsDefault(obj[key], floatSet).toLowerCase();
        for (const kw of _ERROR_KEYWORDS_FOR_PRESERVATION) {
            if (valStr.includes(kw)) {
                keepKeys.add(key);
                break;
            }
        }
    }
    // Small values (tokens <= trunc(50/4) = 12)
    for (const [key, tokens] of kvTokens) {
        if (tokens <= Math.trunc(50 / 4))
            keepKeys.add(key);
    }
    // First K and last K keys (NO clamp — Python has none)
    const kFirst = Math.max(1, pyRound(kTotal * config.first_fraction));
    const kLast = Math.max(1, pyRound(kTotal * config.last_fraction));
    for (const key of keys.slice(0, kFirst))
        keepKeys.add(key);
    for (const key of keys.slice(-kLast))
        keepKeys.add(key);
    // Fill remaining budget with stride-based diverse sampling
    let remaining = Math.max(0, kTotal - keepKeys.size);
    if (remaining > 0) {
        const stride = Math.max(1, Math.trunc((n - 1) / (remaining + 1)));
        for (let i = 0; i < n; i += stride) {
            // Count error keys (recomputed each iteration — port verbatim)
            const countOfErrorKeys = [...keepKeys].filter(k => {
                const vs = pyJsonDumpsDefault(obj[k], floatSet).toLowerCase();
                return _ERROR_KEYWORDS_FOR_PRESERVATION.some(kw => vs.includes(kw));
            }).length;
            if (keepKeys.size >= kTotal + countOfErrorKeys)
                break;
            keepKeys.add(keys[i]);
        }
    }
    const result = {};
    for (const k of keys) {
        if (keepKeys.has(k))
            result[k] = obj[k];
    }
    const strategy = `object:adaptive(${n}->${Object.keys(result).length} keys)`;
    return [result, strategy];
}
// ---------------------------------------------------------------------------
// processValue (lines 2378-2469)
// ---------------------------------------------------------------------------
function processValue(value, depth, query, toolName, bias, config, floatSet, store) {
    if (depth >= 50)
        return [value, ""];
    const infoParts = [];
    if (Array.isArray(value)) {
        if (value.length >= config.min_items_to_analyze) {
            const arrType = classifyArray(value);
            if (arrType === "dict_array") {
                const { rows, strategy, sentinel } = crushArray(value, query, toolName, bias, config, floatSet, store);
                infoParts.push(`${strategy}(${value.length}->${rows.length})`);
                const output = sentinel ? [...rows, sentinel] : rows;
                return [output, infoParts.join(",")];
            }
            else if (arrType === "string_array") {
                const [crushed, strategy] = crushStringArray(value, bias, config, floatSet);
                infoParts.push(`${strategy}(${value.length}->${crushed.length})`);
                return [crushed, infoParts.join(",")];
            }
            else if (arrType === "number_array") {
                const [crushed, strategy] = crushNumberArray(value, bias, config, floatSet);
                // Python checks isinstance(crushed, list) — always true here
                infoParts.push(`${strategy}(${value.length}->${crushed.length})`);
                return [crushed, infoParts.join(",")];
            }
            else if (arrType === "mixed_array") {
                const [crushed, strategy] = crushMixedArray(value, query, toolName, bias, config, floatSet);
                infoParts.push(`${strategy}(${value.length}->${crushed.length})`);
                return [crushed, infoParts.join(",")];
            }
            // NESTED_ARRAY, BOOL_ARRAY, EMPTY — fall through to recursive
        }
        // Not crushable or below threshold — process items recursively
        const processed = [];
        for (const item of value) {
            const [pItem, pInfo] = processValue(item, depth + 1, query, toolName, bias, config, floatSet, store);
            processed.push(pItem);
            if (pInfo)
                infoParts.push(pInfo);
        }
        return [processed, infoParts.join(",")];
    }
    else if (typeof value === "object" && value !== null) {
        const obj = value;
        const processedDict = {};
        for (const [k, v] of Object.entries(obj)) {
            const [pVal, pInfo] = processValue(v, depth + 1, query, toolName, bias, config, floatSet, store);
            processedDict[k] = pVal;
            if (pInfo)
                infoParts.push(pInfo);
        }
        if (Object.keys(processedDict).length >= config.min_items_to_analyze) {
            const [crushedDict, strategy] = crushObject(processedDict, bias, config, floatSet);
            if (strategy !== "object:passthrough") {
                infoParts.push(strategy);
                return [crushedDict, infoParts.join(",")];
            }
        }
        return [processedDict, infoParts.join(",")];
    }
    else {
        return [value, ""];
    }
}
// ---------------------------------------------------------------------------
// crushSmart — top-level entry point
// ---------------------------------------------------------------------------
export function crushSmart(content, config, opts) {
    const floatSet = lexIntegralFloatLiterals(content);
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return {
            compressed: content,
            original: content,
            was_modified: false,
            strategy: "passthrough",
        };
    }
    const query = opts?.query ?? "";
    const toolName = opts?.toolName ?? "";
    const bias = opts?.bias ?? 1.0;
    const store = opts?.store ?? null;
    const [crushed, info] = processValue(parsed, 0, query, toolName, bias, config, floatSet, store);
    const result = pyJsonStringifyCompact(crushed, floatSet);
    const wasModified = result !== content.trim();
    const strategy = info !== "" ? info : "passthrough";
    return {
        compressed: result,
        original: content,
        was_modified: wasModified,
        strategy,
    };
}
