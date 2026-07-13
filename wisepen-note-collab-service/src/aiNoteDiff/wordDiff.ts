export type AiEditJsonUnit =
  | { readonly type: 'plain'; readonly text: string }
  | { readonly type: 'edit'; readonly origin: string; readonly replace: string };

type AiEditToken = {
  readonly value: string;
  readonly start: number;
  readonly end: number;
};

type DiffSegment =
  | {
      readonly kind: 'equal';
      readonly oldTokens: readonly AiEditToken[];
      readonly newTokens: readonly AiEditToken[];
    }
  | { readonly kind: 'delete'; readonly oldTokens: readonly AiEditToken[] }
  | { readonly kind: 'insert'; readonly newTokens: readonly AiEditToken[] };

type MergedHunk =
  | { readonly mode: 'outside'; readonly segments: readonly DiffSegment[] }
  | { readonly mode: 'hunk'; readonly segments: readonly DiffSegment[] };

type MergeDiffHunksOptions = {
  readonly maxGapChars: number;
  readonly maxGapTokens: number;
  readonly breakOnNewline: boolean;
  readonly breakOnSentenceEnd: boolean;
  readonly breakOnClauseBoundary: boolean;
  readonly maxMergedLength: number;
  readonly preferSemanticBoundary: boolean;
};

const AI_DIFF_MAX_LCS_CELLS = 250_000;

const DEFAULT_MERGE_DIFF_HUNKS_OPTIONS: MergeDiffHunksOptions = {
  maxGapChars: 5,
  maxGapTokens: 3,
  breakOnNewline: true,
  breakOnSentenceEnd: true,
  breakOnClauseBoundary: true,
  maxMergedLength: 100,
  preferSemanticBoundary: true,
};

type RawOp = {
  readonly k: 'equal' | 'delete' | 'insert';
  readonly oi: number;
  readonly ni: number;
};

function isSentenceEndChar(ch: string): boolean {
  return '。！？；'.includes(ch) || '.?!'.includes(ch);
}

function segmentEndsWithSentencePunctuation(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  return isSentenceEndChar(trimmed[trimmed.length - 1]);
}

function containsClauseBoundary(text: string): boolean {
  return /[，、；,;]/.test(text);
}

function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2ceaf)
  );
}

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function tokenizeFallbackAsciiCjk(text: string, offset: number): AiEditToken[] {
  const out: AiEditToken[] = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    const codePoint = ch.codePointAt(0);
    const charLength = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;

    if (/\s/.test(ch)) {
      let end = index + 1;
      while (end < text.length && /\s/.test(text[end])) end += 1;
      out.push({ value: text.slice(index, end), start: offset + index, end: offset + end });
      index = end;
      continue;
    }

    if (isAsciiDigit(ch)) {
      let end = index + 1;
      while (end < text.length && (isAsciiDigit(text[end]) || text[end] === '.')) end += 1;
      out.push({ value: text.slice(index, end), start: offset + index, end: offset + end });
      index = end;
      continue;
    }

    if (isAsciiLetter(ch)) {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === '-' && end + 1 < text.length && isAsciiLetter(text[end + 1])) {
          end += 2;
          continue;
        }
        if (isAsciiLetter(text[end])) {
          end += 1;
          continue;
        }
        break;
      }
      out.push({ value: text.slice(index, end), start: offset + index, end: offset + end });
      index = end;
      continue;
    }

    if (codePoint !== undefined && isCjkCodePoint(codePoint)) {
      out.push({
        value: text.slice(index, index + charLength),
        start: offset + index,
        end: offset + index + charLength,
      });
      index += charLength;
      continue;
    }

    out.push({ value: ch, start: offset + index, end: offset + index + 1 });
    index += 1;
  }
  return out;
}

function tokenizeChunk(chunk: string, offset: number): AiEditToken[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
      const out: AiEditToken[] = [];
      for (const segment of segmenter.segment(chunk)) {
        if (!segment.segment) continue;
        out.push({
          value: segment.segment,
          start: offset + segment.index,
          end: offset + segment.index + segment.segment.length,
        });
      }
      if (out.length > 0) return out;
    } catch {
      // Fall back to deterministic ASCII/CJK tokenization.
    }
  }
  return tokenizeFallbackAsciiCjk(chunk, offset);
}

function tokenizeForAiEdit(text: string): AiEditToken[] {
  const out: AiEditToken[] = [];
  let base = 0;
  while (base < text.length) {
    if (text[base] === '\n') {
      out.push({ value: '\n', start: base, end: base + 1 });
      base += 1;
      continue;
    }
    const newline = text.indexOf('\n', base);
    const lineEnd = newline === -1 ? text.length : newline;
    const chunk = text.slice(base, lineEnd);
    if (chunk) out.push(...tokenizeChunk(chunk, base));
    base = lineEnd;
  }
  return out;
}

function tokensText(tokens: readonly AiEditToken[]): string {
  return tokens.map((token) => token.value).join('');
}

function buildLinearFallbackSegments(
  oldTokens: readonly AiEditToken[],
  newTokens: readonly AiEditToken[],
): DiffSegment[] {
  let prefixLength = 0;
  while (
    prefixLength < oldTokens.length &&
    prefixLength < newTokens.length &&
    oldTokens[prefixLength].value === newTokens[prefixLength].value
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldTokens.length - prefixLength &&
    suffixLength < newTokens.length - prefixLength &&
    oldTokens[oldTokens.length - 1 - suffixLength].value ===
      newTokens[newTokens.length - 1 - suffixLength].value
  ) {
    suffixLength += 1;
  }

  const segments: DiffSegment[] = [];
  if (prefixLength > 0) {
    segments.push({
      kind: 'equal',
      oldTokens: oldTokens.slice(0, prefixLength),
      newTokens: newTokens.slice(0, prefixLength),
    });
  }
  const oldMiddle = oldTokens.slice(prefixLength, oldTokens.length - suffixLength);
  const newMiddle = newTokens.slice(prefixLength, newTokens.length - suffixLength);
  if (oldMiddle.length > 0) segments.push({ kind: 'delete', oldTokens: oldMiddle });
  if (newMiddle.length > 0) segments.push({ kind: 'insert', newTokens: newMiddle });
  if (suffixLength > 0) {
    segments.push({
      kind: 'equal',
      oldTokens: oldTokens.slice(oldTokens.length - suffixLength),
      newTokens: newTokens.slice(newTokens.length - suffixLength),
    });
  }
  return segments;
}

function diffTokens(
  oldTokens: readonly AiEditToken[],
  newTokens: readonly AiEditToken[],
): DiffSegment[] {
  const oldLength = oldTokens.length;
  const newLength = newTokens.length;
  if (oldLength * newLength > AI_DIFF_MAX_LCS_CELLS) {
    return buildLinearFallbackSegments(oldTokens, newTokens);
  }

  const oldValues = oldTokens.map((token) => token.value);
  const newValues = newTokens.map((token) => token.value);
  const dp: number[][] = Array.from({ length: oldLength + 1 }, () =>
    Array(newLength + 1).fill(0),
  );
  for (let oldIndex = 1; oldIndex <= oldLength; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newLength; newIndex += 1) {
      dp[oldIndex][newIndex] =
        oldValues[oldIndex - 1] === newValues[newIndex - 1]
          ? dp[oldIndex - 1][newIndex - 1] + 1
          : Math.max(dp[oldIndex - 1][newIndex], dp[oldIndex][newIndex - 1]);
    }
  }

  const raw: RawOp[] = [];
  let oldCursor = oldLength;
  let newCursor = newLength;
  while (oldCursor > 0 || newCursor > 0) {
    if (
      oldCursor > 0 &&
      newCursor > 0 &&
      oldValues[oldCursor - 1] === newValues[newCursor - 1]
    ) {
      raw.push({ k: 'equal', oi: oldCursor - 1, ni: newCursor - 1 });
      oldCursor -= 1;
      newCursor -= 1;
    } else if (newCursor > 0 && (oldCursor === 0 || dp[oldCursor][newCursor - 1] >= dp[oldCursor - 1][newCursor])) {
      raw.push({ k: 'insert', oi: oldCursor - 1, ni: newCursor - 1 });
      newCursor -= 1;
    } else {
      raw.push({ k: 'delete', oi: oldCursor - 1, ni: newCursor - 1 });
      oldCursor -= 1;
    }
  }
  raw.reverse();

  const segments: DiffSegment[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const kind = raw[cursor].k;
    if (kind === 'equal') {
      const oldStart = raw[cursor].oi;
      const newStart = raw[cursor].ni;
      let length = 0;
      while (cursor < raw.length && raw[cursor].k === 'equal') {
        length += 1;
        cursor += 1;
      }
      segments.push({
        kind: 'equal',
        oldTokens: oldTokens.slice(oldStart, oldStart + length),
        newTokens: newTokens.slice(newStart, newStart + length),
      });
      continue;
    }
    if (kind === 'delete') {
      const oldStart = raw[cursor].oi;
      let length = 0;
      while (cursor < raw.length && raw[cursor].k === 'delete') {
        length += 1;
        cursor += 1;
      }
      segments.push({ kind: 'delete', oldTokens: oldTokens.slice(oldStart, oldStart + length) });
      continue;
    }

    const newStart = raw[cursor].ni;
    let length = 0;
    while (cursor < raw.length && raw[cursor].k === 'insert') {
      length += 1;
      cursor += 1;
    }
    segments.push({ kind: 'insert', newTokens: newTokens.slice(newStart, newStart + length) });
  }
  return segments;
}

function coalesceSegments(segments: readonly DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const segment of segments) {
    const previous = out[out.length - 1];
    if (!previous) {
      out.push(segment);
      continue;
    }
    if (segment.kind === 'equal' && previous.kind === 'equal') {
      out[out.length - 1] = {
        kind: 'equal',
        oldTokens: [...previous.oldTokens, ...segment.oldTokens],
        newTokens: [...previous.newTokens, ...segment.newTokens],
      };
      continue;
    }
    if (segment.kind === 'delete' && previous.kind === 'delete') {
      out[out.length - 1] = {
        kind: 'delete',
        oldTokens: [...previous.oldTokens, ...segment.oldTokens],
      };
      continue;
    }
    if (segment.kind === 'insert' && previous.kind === 'insert') {
      out[out.length - 1] = {
        kind: 'insert',
        newTokens: [...previous.newTokens, ...segment.newTokens],
      };
      continue;
    }
    out.push(segment);
  }
  return out;
}

function segmentVisibleLength(segment: DiffSegment): number {
  if (segment.kind === 'equal') {
    return Math.max(tokensText(segment.oldTokens).length, tokensText(segment.newTokens).length);
  }
  if (segment.kind === 'delete') return tokensText(segment.oldTokens).length;
  return tokensText(segment.newTokens).length;
}

function totalVisibleLength(segments: readonly DiffSegment[]): number {
  return segments.reduce((sum, segment) => sum + segmentVisibleLength(segment), 0);
}

function equalGapViolatesMerge(
  oldTokens: readonly AiEditToken[],
  newTokens: readonly AiEditToken[],
  options: MergeDiffHunksOptions,
): boolean {
  const oldText = tokensText(oldTokens);
  if (options.breakOnNewline && (oldText.includes('\n') || tokensText(newTokens).includes('\n'))) {
    return true;
  }
  if (oldText.length > options.maxGapChars || oldTokens.length > options.maxGapTokens) {
    return true;
  }
  if (options.preferSemanticBoundary) {
    if (options.breakOnSentenceEnd && segmentEndsWithSentencePunctuation(oldText)) return true;
    if (options.breakOnClauseBoundary && containsClauseBoundary(oldText)) return true;
  }
  return false;
}

function splitIntoMergeBlocks(
  segments: readonly DiffSegment[],
): Array<{ kind: 'equal'; segment: DiffSegment } | { kind: 'dirty'; parts: readonly DiffSegment[] }> {
  const blocks: Array<
    { kind: 'equal'; segment: DiffSegment } | { kind: 'dirty'; parts: readonly DiffSegment[] }
  > = [];
  let cursor = 0;
  while (cursor < segments.length) {
    const segment = segments[cursor];
    if (segment.kind === 'equal') {
      blocks.push({ kind: 'equal', segment });
      cursor += 1;
      continue;
    }
    const parts: DiffSegment[] = [];
    while (cursor < segments.length && segments[cursor].kind !== 'equal') {
      parts.push(segments[cursor]);
      cursor += 1;
    }
    blocks.push({ kind: 'dirty', parts: coalesceSegments(parts) });
  }
  return blocks;
}

function mergeDiffHunks(
  segments: readonly DiffSegment[],
  options: MergeDiffHunksOptions = DEFAULT_MERGE_DIFF_HUNKS_OPTIONS,
): MergedHunk[] {
  if (segments.length === 0) return [];
  const blocks = splitIntoMergeBlocks(segments);
  const hunks: MergedHunk[] = [];
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];
    if (block.kind === 'equal') {
      hunks.push({ mode: 'outside', segments: [block.segment] });
      index += 1;
      continue;
    }

    let parts = [...block.parts];
    let visibleLength = totalVisibleLength(parts);
    index += 1;
    while (
      index + 1 < blocks.length &&
      blocks[index].kind === 'equal' &&
      blocks[index + 1].kind === 'dirty'
    ) {
      const gapBlock = blocks[index];
      const nextDirtyBlock = blocks[index + 1];
      if (gapBlock.kind !== 'equal' || nextDirtyBlock.kind !== 'dirty') break;
      const gap = gapBlock.segment;
      if (
        gap.kind !== 'equal' ||
        equalGapViolatesMerge(gap.oldTokens, gap.newTokens, options)
      ) {
        break;
      }
      const nextVisibleLength =
        visibleLength + segmentVisibleLength(gap) + totalVisibleLength(nextDirtyBlock.parts);
      if (nextVisibleLength > options.maxMergedLength) break;
      parts = [...parts, gap, ...nextDirtyBlock.parts];
      visibleLength = nextVisibleLength;
      index += 2;
    }
    hunks.push({ mode: 'hunk', segments: coalesceSegments(parts) });
  }

  return hunks;
}

function buildHighChangeRatioUnits(origin: string, replace: string): AiEditJsonUnit[] {
  const oldTokens = tokenizeForAiEdit(origin);
  const newTokens = tokenizeForAiEdit(replace);
  let prefixLength = 0;
  while (
    prefixLength < oldTokens.length &&
    prefixLength < newTokens.length &&
    oldTokens[prefixLength].value === newTokens[prefixLength].value
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldTokens.length - prefixLength &&
    suffixLength < newTokens.length - prefixLength &&
    oldTokens[oldTokens.length - 1 - suffixLength].value ===
      newTokens[newTokens.length - 1 - suffixLength].value
  ) {
    suffixLength += 1;
  }

  const oldPrefixEnd = prefixLength > 0 ? oldTokens[prefixLength - 1].end : 0;
  const newPrefixEnd = prefixLength > 0 ? newTokens[prefixLength - 1].end : 0;
  const oldSuffixStart =
    suffixLength > 0 ? oldTokens[oldTokens.length - suffixLength].start : origin.length;
  const newSuffixStart =
    suffixLength > 0 ? newTokens[newTokens.length - suffixLength].start : replace.length;
  const units: AiEditJsonUnit[] = [];
  const prefix = origin.slice(0, oldPrefixEnd);
  const suffix = origin.slice(oldSuffixStart);
  if (prefix) units.push({ type: 'plain', text: prefix });
  const originMiddle = origin.slice(oldPrefixEnd, oldSuffixStart);
  const replaceMiddle = replace.slice(newPrefixEnd, newSuffixStart);
  if (originMiddle || replaceMiddle) {
    units.push({ type: 'edit', origin: originMiddle, replace: replaceMiddle });
  }
  if (suffix) units.push({ type: 'plain', text: suffix });
  return units.length > 0 ? units : [{ type: 'edit', origin, replace }];
}

function ensureConservation(
  units: AiEditJsonUnit[],
  origin: string,
  replace: string,
): AiEditJsonUnit[] {
  const restoredOrigin = units
    .map((unit) => (unit.type === 'plain' ? unit.text : unit.origin))
    .join('');
  const restoredReplace = units
    .map((unit) => (unit.type === 'plain' ? unit.text : unit.replace))
    .join('');
  return restoredOrigin === origin && restoredReplace === replace
    ? units
    : [{ type: 'edit', origin, replace }];
}

export function buildAiEditJsonUnits(origin: string, replace: string): AiEditJsonUnit[] {
  const oldTokens = tokenizeForAiEdit(origin);
  const newTokens = tokenizeForAiEdit(replace);
  const totalTokens = oldTokens.length + newTokens.length;
  const segments = diffTokens(oldTokens, newTokens);

  if (totalTokens > 0) {
    let deleteCount = 0;
    let insertCount = 0;
    for (const segment of segments) {
      if (segment.kind === 'delete') deleteCount += segment.oldTokens.length;
      else if (segment.kind === 'insert') insertCount += segment.newTokens.length;
    }
    if ((deleteCount + insertCount) / totalTokens > 0.6) {
      return ensureConservation(buildHighChangeRatioUnits(origin, replace), origin, replace);
    }
  }

  const units: AiEditJsonUnit[] = [];
  for (const hunk of mergeDiffHunks(segments)) {
    if (hunk.mode === 'outside') {
      const text = hunk.segments
        .map((segment) => (segment.kind === 'equal' ? tokensText(segment.newTokens) : ''))
        .join('');
      if (text) units.push({ type: 'plain', text });
      continue;
    }

    const originText = hunk.segments
      .filter((segment) => segment.kind !== 'insert')
      .map((segment) => (segment.kind === 'delete' ? tokensText(segment.oldTokens) : tokensText(segment.oldTokens)))
      .join('');
    const replaceText = hunk.segments
      .filter((segment) => segment.kind !== 'delete')
      .map((segment) => (segment.kind === 'insert' ? tokensText(segment.newTokens) : tokensText(segment.newTokens)))
      .join('');
    units.push({ type: 'edit', origin: originText, replace: replaceText });
  }

  return ensureConservation(units, origin, replace);
}
