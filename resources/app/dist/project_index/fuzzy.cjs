'use strict';

/**
 * High-Speed Fuzzy Matching Algorithm for FRIDAY Code and Path Search
 */

/**
 * Calculates a fuzzy match score for pattern against target string
 * @param {string} pattern Search query (e.g. "brain", "medcont", "MC")
 * @param {string} target String to match against (e.g. "media_controller.py", "MediaController")
 * @returns {{ matched: boolean, score: number, positions: number[] }}
 */
function fuzzyMatch(pattern, target) {
  if (!pattern || !target) {
    return { matched: false, score: 0, positions: [] };
  }

  const pLower = pattern.toLowerCase();
  const tLower = target.toLowerCase();

  // Exact match
  if (target === pattern) {
    return { matched: true, score: 1000, positions: target.split('').map((_, i) => i) };
  }
  if (tLower === pLower) {
    return { matched: true, score: 900, positions: target.split('').map((_, i) => i) };
  }

  // Exact prefix match
  if (target.startsWith(pattern)) {
    return { matched: true, score: 800, positions: pattern.split('').map((_, i) => i) };
  }
  if (tLower.startsWith(pLower)) {
    return { matched: true, score: 750, positions: pattern.split('').map((_, i) => i) };
  }

  // Substring match
  const substrIdx = tLower.indexOf(pLower);
  if (substrIdx !== -1) {
    const isBoundary = substrIdx === 0 || /[/\\_.\- ]/.test(target[substrIdx - 1]);
    const score = (isBoundary ? 700 : 500) - (substrIdx * 2);
    const positions = [];
    for (let i = 0; i < pattern.length; i++) positions.push(substrIdx + i);
    return { matched: true, score, positions };
  }

  // Subsequence / Acronym matching
  let pIdx = 0;
  let tIdx = 0;
  let score = 100;
  let consecutive = 0;
  let prevMatchIdx = -1;
  const positions = [];

  while (pIdx < pattern.length && tIdx < target.length) {
    const pChar = pLower[pIdx];
    const tChar = tLower[tIdx];

    if (pChar === tChar) {
      positions.push(tIdx);

      // Boundary check
      const isStart = tIdx === 0;
      const isSepBoundary = !isStart && /[/\\_.\- ]/.test(target[tIdx - 1]);
      const isCamelBoundary = !isStart && target[tIdx] >= 'A' && target[tIdx] <= 'Z' && target[tIdx - 1] >= 'a' && target[tIdx - 1] <= 'z';

      if (isStart || isSepBoundary || isCamelBoundary) {
        score += 45;
      }

      // Case match bonus
      if (pattern[pIdx] === target[tIdx]) {
        score += 10;
      }

      // Consecutive bonus
      if (prevMatchIdx === tIdx - 1) {
        consecutive++;
        score += 25 * consecutive;
      } else {
        consecutive = 0;
        if (prevMatchIdx !== -1) {
          // Gap penalty
          score -= (tIdx - prevMatchIdx - 1) * 2;
        }
      }

      prevMatchIdx = tIdx;
      pIdx++;
    }
    tIdx++;
  }

  // If entire pattern was matched in sequence
  if (pIdx === pattern.length) {
    // Length penalty so shorter exact matches rank higher
    score -= (target.length - pattern.length);
    return { matched: true, score: Math.max(1, score), positions };
  }

  return { matched: false, score: 0, positions: [] };
}

/**
 * Rank a list of candidate records against a query
 * @param {Array<Object>} candidates Array of records
 * @param {string} query Search query
 * @param {Function} [extractor] Function returning string to match (defaults to item.name)
 * @returns {Array<Object>} Sorted list of matching records with score
 */
function rankResults(candidates, query, extractor = (item) => item.name) {
  if (!query || !candidates) return candidates || [];
  const q = query.trim();
  const results = [];

  for (const item of candidates) {
    const target = extractor(item) || '';
    const match = fuzzyMatch(q, target);
    if (match.matched) {
      let finalScore = match.score;

      // Priority root bonus (e.g. root_id 1 is highest)
      if (item.root_id === 1) finalScore += 60;
      else if (item.root_id === 2) finalScore += 30; // Desktop

      // Depth bonus: shallow paths rank higher than deeply nested archive/test paths
      const relPath = item.relative_path || '';
      const depth = relPath.split(/[/\\]/).length;
      finalScore += Math.max(0, 40 - (depth * 5));

      // Penalize archive / backup files
      if (/(archive|backup|bak|old|tmp)/i.test(relPath)) {
        finalScore -= 80;
      }

      results.push({
        ...item,
        _score: finalScore,
        _matchPositions: match.positions
      });
    }
  }

  results.sort((a, b) => b._score - a._score);
  return results;
}

module.exports = { fuzzyMatch, rankResults };
