import { describe, expect, it } from 'vitest';
import { computeIndentEdit } from './editor-indent';

/** `|` を選択の端として書いた文字列から、値と選択範囲を取り出す */
function withSelection(marked: string) {
  const start = marked.indexOf('|');
  const end = marked.indexOf('|', start + 1);
  if (end === -1) return { value: marked.replace('|', ''), start, end: start };
  return { value: marked.replace(/\|/g, ''), start, end: end - 1 };
}

function apply(marked: string, outdent = false) {
  const { value, start, end } = withSelection(marked);
  const edit = computeIndentEdit(value, start, end, outdent);
  if (!edit) return null;
  const { value: next, selectionStart, selectionEnd } = edit;
  // 置き換え範囲と挿入文字列から編集後の値が作れること
  expect(value.slice(0, edit.replaceStart) + edit.insertText + value.slice(edit.replaceEnd)).toBe(next);
  if (selectionStart === selectionEnd) {
    return next.slice(0, selectionStart) + '|' + next.slice(selectionStart);
  }
  return (
    next.slice(0, selectionStart) + '|' + next.slice(selectionStart, selectionEnd) + '|' + next.slice(selectionEnd)
  );
}

describe('computeIndentEdit', () => {
  it('選択なしの Tab はカーソル位置に空白 2 つを入れる', () => {
    expect(apply('SELECT|a')).toBe('SELECT  |a');
  });

  it('複数行を選んだ Tab は各行の先頭を字下げする', () => {
    expect(apply('SELECT\n|a,\nb|\nFROM t')).toBe('SELECT\n|  a,\n  b|\nFROM t');
  });

  it('選択の終端が行頭ちょうどなら、その行は字下げしない', () => {
    expect(apply('|a\nb\n|c')).toBe('|  a\n  b\n|c');
  });

  it('Shift+Tab は各行の先頭から 1 段取る', () => {
    expect(apply('|    a\n  b\nc|', true)).toBe('|  a\nb\nc|');
  });

  it('Shift+Tab はカーソルの行だけを戻す', () => {
    expect(apply('x\n    a|b\ny', true)).toBe('x\n  a|b\ny');
  });

  it('戻す字下げが無いときは何もしない', () => {
    expect(apply('a|b', true)).toBeNull();
  });

  it('Shift+Tab で選択の始点が行頭より前に出ない', () => {
    expect(apply(' |a\n  b|', true)).toBe('|a\nb|');
  });
});
