import JoditEditor from 'jodit-react';
import { useMemo } from 'react';
import type { ComponentProps } from 'react';
import type { IJodit } from 'jodit/esm/types/jodit';

export type RichHtmlEditorHandle = IJodit;

type JoditConfig = NonNullable<ComponentProps<typeof JoditEditor>['config']>;

interface RichHtmlEditorProps {
  value: string;
  onChange: (html: string) => void;
  minHeight?: number;
  className?: string;
  onReady?: (editor: RichHtmlEditorHandle) => void;
  onPickImage?: () => void;
}

export function normalizeEmptyRichHtml(html: string) {
  const compact = html
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();

  if (
    compact === '' ||
    compact === '<p></p>' ||
    compact === '<p><br></p>' ||
    compact === '<p><br/></p>' ||
    compact === '<div><br></div>' ||
    compact === '<div><br/></div>'
  ) {
    return '';
  }

  return html;
}

export function RichHtmlEditor({
  value,
  onChange,
  minHeight = 320,
  className = '',
  onReady,
  onPickImage,
}: RichHtmlEditorProps) {
  const config = useMemo<JoditConfig>(() => {
    const controls = onPickImage
      ? {
          image: {
            exec: () => onPickImage(),
          },
        }
      : undefined;

    return {
      toolbarSticky: false,
      statusbar: false,
      showCharsCounter: false,
      showWordsCounter: false,
      showXPathInStatusbar: false,
      askBeforePasteHTML: false,
      askBeforePasteFromWord: false,
      defaultActionOnPaste: 'insert_as_html',
      height: '100%',
      minHeight,
      uploader: {
        insertImageAsBase64URI: false,
      },
      ...(controls ? { controls } : {}),
    };
  }, [minHeight, onPickImage]);

  return (
    <div
      className={`wysiwyg-editor jodit-editor-wrap ${className}`.trim()}
      style={{ minHeight }}
    >
      <JoditEditor
        value={value}
        config={config}
        onChange={onChange}
        editorRef={onReady}
      />
    </div>
  );
}
