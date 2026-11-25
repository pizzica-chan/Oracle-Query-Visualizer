/** SQL エディタの Tab / Shift+Tab による字下げ */

export const INDENT = '  ';

export interface IndentEdit {
  /** 置き換える範囲（編集前の value 上） */
  replaceStart: number;
  replaceEnd: number;
  /** その範囲に入れる文字列 */
  insertText: string;
  /** 編集後の value */
  value: string;
  /** 編集後の選択範囲 */
  selectionStart: number;
  selectionEnd: number;
}

function lineStartOf(value: string, offset: number): number {
  return value.lastIndexOf('\n', offset - 1) + 1;
}

/**
 * Tab（outdent = false）と Shift+Tab（outdent = true）の編集内容を返す。変える必要がなければ null。
 * - 選択なしの Tab: カーソル位置に字下げを入れる
 * - 選択ありの Tab: 選択にかかる各行の先頭に字下げを足す
 * - Shift+Tab: 選択（またはカーソル）にかかる各行の先頭から、字下げを 1 段（空白 2 つかタブ 1 つ）まで取る
 * 選択の終端が行頭ちょうどのときは、その行は選択に含めない（行を丸ごと選んだときの普通の範囲）
 */
export function computeIndentEdit(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  outdent: boolean,
): IndentEdit | null {
  if (!outdent && selectionStart === selectionEnd) {
    return {
      replaceStart: selectionStart,
      replaceEnd: selectionEnd,
      insertText: INDENT,
      value: value.slice(0, selectionStart) + INDENT + value.slice(selectionEnd),
      selectionStart: selectionStart + INDENT.length,
      selectionEnd: selectionStart + INDENT.length,
    };
  }

  const blockStart = lineStartOf(value, selectionStart);
  let blockEndOffset = selectionEnd;
  if (selectionEnd > selectionStart && lineStartOf(value, selectionEnd) === selectionEnd) {
    blockEndOffset = selectionEnd - 1;
  }
  const nextNewline = value.indexOf('\n', blockEndOffset);
  const blockEnd = nextNewline === -1 ? value.length : nextNewline;
  const lines = value.slice(blockStart, blockEnd).split('\n');

  let firstLineDelta = 0;
  let totalDelta = 0;
  const changed = lines.map((line, index) => {
    if (!outdent) {
      totalDelta += INDENT.length;
      if (index === 0) firstLineDelta = INDENT.length;
      return INDENT + line;
    }
    const removed = line.startsWith(INDENT) ? INDENT.length : /^[ \t]/.test(line) ? 1 : 0;
    totalDelta -= removed;
    if (index === 0) firstLineDelta = -removed;
    return line.slice(removed);
  });

  if (totalDelta === 0) return null;
  const insertText = changed.join('\n');
  // 選択の始点は 1 行目の字下げの増減に合わせて動かす。ただし行頭より前には出さない。
  // 行頭から選んでいたときは行頭のままにする（行を丸ごと選んだ状態を保つ）
  const nextStart =
    !outdent && selectionStart === blockStart
      ? blockStart
      : Math.max(blockStart, selectionStart + firstLineDelta);
  const nextEnd =
    selectionStart === selectionEnd ? nextStart : Math.max(nextStart, selectionEnd + totalDelta);
  return {
    replaceStart: blockStart,
    replaceEnd: blockEnd,
    insertText,
    value: value.slice(0, blockStart) + insertText + value.slice(blockEnd),
    selectionStart: nextStart,
    selectionEnd: nextEnd,
  };
}
