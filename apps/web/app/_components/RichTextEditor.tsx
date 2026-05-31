'use client';

import { useEffect, useRef } from 'react';

/**
 * Minimal WYSIWYG editor for outreach drafts. A contenteditable surface plus a
 * small formatting toolbar (bold / italic / link / bullet list). No editor
 * dependency — this is a thin approval-surface control, not a document editor,
 * so document.execCommand keeps it dependency-free and good enough for email.
 *
 * Uncontrolled by design: the initial HTML is written into the node ONCE (a
 * controlled contenteditable fights the caret on every keystroke). The current
 * HTML is read back via onChange on input and on every command.
 */
interface Props {
  initialHtml: string;
  onChange: (html: string) => void;
}

const BTN: React.CSSProperties = {
  padding: '.2rem .5rem', fontSize: '.78rem', lineHeight: 1.2,
  border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)',
  cursor: 'pointer', borderRadius: 3,
};

export function RichTextEditor({ initialHtml, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Seed the editable node once. Re-seeding on prop change would yank the caret.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== initialHtml) {
      ref.current.innerHTML = initialHtml;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = () => { if (ref.current) onChange(ref.current.innerHTML); };

  // execCommand is deprecated but universally supported and exactly right for a
  // 4-button email editor. Refocus so the command applies to the live selection.
  const cmd = (command: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, value);
    emit();
  };

  const addLink = () => {
    const url = window.prompt('Link URL (https://…)');
    if (!url) return;
    if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) {
      window.alert('Use an http(s):// or mailto: URL.');
      return;
    }
    cmd('createLink', url);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: '.35rem', marginBottom: '.4rem', flexWrap: 'wrap' }}>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('bold')} style={{ ...BTN, fontWeight: 700 }} title="Bold">B</button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('italic')} style={{ ...BTN, fontStyle: 'italic' }} title="Italic">i</button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={addLink} style={BTN} title="Insert link">link</button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('insertUnorderedList')} style={BTN} title="Bullet list">• list</button>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        style={{
          minHeight: 160, maxHeight: 360, overflowY: 'auto',
          padding: '.5rem .6rem', fontSize: '.88rem', lineHeight: 1.55,
          border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
          borderRadius: 4, outline: 'none',
        }}
      />
    </div>
  );
}
