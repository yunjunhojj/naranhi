import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
  createImageBlock,
  createTextBlock,
  getDocumentText,
  prepareBlocksForStorage,
  restoreBlocks,
  type DocumentBlock,
  type ImageBlock
} from "./document";
import {
  getOllamaStatus,
  type OllamaStatus,
  recognizeImageText,
  translateSentence
} from "./ollama";
import { countWords, type Language, normalizePastedText, splitSentences } from "./text";

const DEFAULT_MODEL = "translategemma:12b-it-q4_K_M";
const STORAGE_KEY = "parallel-translator-document-v1";

const LANGUAGE_LABELS: Record<Language, { native: string }> = {
  en: { native: "English" },
  ko: { native: "한국어" }
};

type TranslationState = "idle" | "queued" | "translating" | "done" | "error";

type Translation = {
  source: string;
  target: string;
  state: TranslationState;
  elapsedMs?: number;
  error?: string;
  edited?: boolean;
};

type SavedDocument = {
  source?: string;
  blocks?: DocumentBlock[];
  model: string;
  sourceLanguage?: Language;
  targetLanguage?: Language;
  translations: Record<string, Translation>;
};

function loadDocument(): SavedDocument {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved) as SavedDocument;
  } catch {
    // A damaged draft should never prevent the editor from opening.
  }
  return {
    source: "",
    model: DEFAULT_MODEL,
    sourceLanguage: "en",
    targetLanguage: "ko",
    translations: {}
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("이미지를 읽지 못했습니다."));
    };
    reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

function textAreaRows(value: string): number {
  const visualLines = value
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 52)), 0);
  return Math.max(2, visualLines);
}

function App() {
  const initial = useMemo(loadDocument, []);
  const [blocks, setBlocks] = useState<DocumentBlock[]>(() =>
    restoreBlocks(initial.blocks, initial.source)
  );
  const [model, setModel] = useState(initial.model || DEFAULT_MODEL);
  const [sourceLanguage, setSourceLanguage] = useState<Language>(initial.sourceLanguage ?? "en");
  const [targetLanguage, setTargetLanguage] = useState<Language>(initial.targetLanguage ?? "ko");
  const [translations, setTranslations] = useState<Record<string, Translation>>(
    initial.translations ?? {}
  );
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [translationRevision, setTranslationRevision] = useState(0);
  const [editingOcrBlockId, setEditingOcrBlockId] = useState<string | null>(null);
  const runId = useRef(0);
  const nextOcrRun = useRef(0);
  const ocrRuns = useRef(new Map<string, number>());
  const textEditorRefs = useRef(new Map<string, HTMLTextAreaElement>());

  const source = useMemo(() => getDocumentText(blocks), [blocks]);
  const sentences = useMemo(() => splitSentences(source, sourceLanguage), [source, sourceLanguage]);
  const words = useMemo(() => countWords(source), [source]);
  const imageBlocks = useMemo(
    () => blocks.filter((block): block is ImageBlock => block.type === "image"),
    [blocks]
  );
  const processingOcrCount = imageBlocks.filter((block) => block.ocrState === "processing").length;

  const checkOllama = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await getOllamaStatus(model));
    } catch (error) {
      setStatus({
        running: false,
        modelInstalled: false,
        installedModels: [],
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setChecking(false);
    }
  }, [model]);

  useEffect(() => {
    void checkOllama();
  }, [checkOllama]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const payload: SavedDocument = {
        source,
        blocks: prepareBlocksForStorage(blocks),
        model,
        sourceLanguage,
        targetLanguage,
        translations
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      setLastSaved(new Date());
    }, 350);
    return () => window.clearTimeout(timer);
  }, [blocks, model, source, sourceLanguage, targetLanguage, translations]);

  useEffect(() => {
    const currentRun = ++runId.current;
    const timer = window.setTimeout(async () => {
      if (!status?.running || !status.modelInstalled) return;

      const pending = sentences.filter((sentence) => {
        const existing = translations[sentence.key];
        return !existing || existing.source !== sentence.text || existing.state !== "done";
      });

      for (const sentence of pending) {
        if (runId.current !== currentRun) return;
        setTranslations((previous) => ({
          ...previous,
          [sentence.key]: { source: sentence.text, target: "", state: "translating" }
        }));

        try {
          const result = await translateSentence(sentence.text, model, sourceLanguage, targetLanguage);
          if (runId.current !== currentRun) return;
          setTranslations((previous) => ({
            ...previous,
            [sentence.key]: {
              source: sentence.text,
              target: result.text,
              state: "done",
              elapsedMs: result.elapsedMs
            }
          }));
        } catch (error) {
          if (runId.current !== currentRun) return;
          setTranslations((previous) => ({
            ...previous,
            [sentence.key]: {
              source: sentence.text,
              target: "",
              state: "error",
              error: error instanceof Error ? error.message : String(error)
            }
          }));
        }
      }
    }, 800);

    return () => window.clearTimeout(timer);
  }, [model, sentences, sourceLanguage, status?.modelInstalled, status?.running, targetLanguage, translationRevision]);

  const updateImageBlock = useCallback(
    (blockId: string, update: (block: ImageBlock) => ImageBlock) => {
      setBlocks((previous) => previous.map((block) =>
        block.type === "image" && block.id === blockId ? update(block) : block
      ));
    },
    []
  );

  const runOcr = useCallback(async (
    blockId: string,
    imageDataUrl: string,
    language: Language = sourceLanguage
  ) => {
    const currentRun = ++nextOcrRun.current;
    ocrRuns.current.set(blockId, currentRun);
    updateImageBlock(blockId, (block) => ({
      ...block,
      ocrState: "processing",
      elapsedMs: null,
      error: null
    }));

    try {
      const result = await recognizeImageText(imageDataUrl, language);
      if (ocrRuns.current.get(blockId) !== currentRun) return;
      runId.current += 1;
      updateImageBlock(blockId, (block) => ({
        ...block,
        ocrText: normalizePastedText(result.text),
        ocrState: "done",
        elapsedMs: result.elapsedMs,
        error: null
      }));
      setTranslationRevision((revision) => revision + 1);
    } catch (error) {
      if (ocrRuns.current.get(blockId) !== currentRun) return;
      updateImageBlock(blockId, (block) => ({
        ...block,
        ocrState: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }, [sourceLanguage, updateImageBlock]);

  const focusTextBlock = (blockId: string, cursor: number) => {
    window.requestAnimationFrame(() => {
      const editor = textEditorRefs.current.get(blockId);
      editor?.focus();
      editor?.setSelectionRange(cursor, cursor);
    });
  };

  const handleTextPaste = async (
    blockId: string,
    event: ReactClipboardEvent<HTMLTextAreaElement>
  ) => {
    const imageItem = Array.from(event.clipboardData.items).find((item) =>
      item.type.startsWith("image/")
    );

    if (!imageItem) {
      const pastedText = event.clipboardData.getData("text/plain");
      if (!pastedText) return;
      event.preventDefault();
      const formattedText = normalizePastedText(pastedText);
      const editor = event.currentTarget;
      const selectionStart = editor.selectionStart;
      const selectionEnd = editor.selectionEnd;
      setBlocks((previous) => previous.map((block) =>
        block.type === "text" && block.id === blockId
          ? { ...block, text: `${block.text.slice(0, selectionStart)}${formattedText}${block.text.slice(selectionEnd)}` }
          : block
      ));
      focusTextBlock(blockId, selectionStart + formattedText.length);
      return;
    }

    event.preventDefault();
    const imageFile = imageItem.getAsFile();
    if (!imageFile) return;
    if (imageFile.size > 20 * 1024 * 1024) {
      window.alert("이미지는 최대 20MB까지 처리할 수 있습니다.");
      return;
    }

    const editor = event.currentTarget;
    const selectionStart = editor.selectionStart;
    const selectionEnd = editor.selectionEnd;

    try {
      const imageDataUrl = await readFileAsDataUrl(imageFile);
      const imageBlock = createImageBlock(imageDataUrl);
      const trailingBlock = createTextBlock();
      setBlocks((previous) => previous.flatMap((block) => {
        if (block.type !== "text" || block.id !== blockId) return [block];
        return [
          { ...block, text: block.text.slice(0, selectionStart) },
          imageBlock,
          { ...trailingBlock, text: block.text.slice(selectionEnd) }
        ];
      }));
      focusTextBlock(trailingBlock.id, 0);
      void runOcr(imageBlock.id, imageDataUrl);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  const updateTextBlock = (blockId: string, text: string) => {
    setBlocks((previous) => previous.map((block) =>
      block.type === "text" && block.id === blockId ? { ...block, text } : block
    ));
  };

  const toggleImageBlock = (blockId: string) => {
    updateImageBlock(blockId, (block) => {
      if (block.view === "image" && block.ocrState !== "done") return block;
      if (block.view === "text" && !block.imageDataUrl) return block;
      return { ...block, view: block.view === "image" ? "text" : "image" };
    });
  };

  const deleteImageBlock = (blockId: string) => {
    ocrRuns.current.delete(blockId);
    setBlocks((previous) => {
      const next = previous.filter((block) => block.id !== blockId);
      return next.length > 0 ? next : [createTextBlock()];
    });
  };

  const handleImageKeyDown = (blockId: string, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleImageBlock(blockId);
    }
  };

  const updateTarget = (key: string, value: string) => {
    setTranslations((previous) => {
      const current = previous[key];
      if (!current) return previous;
      return { ...previous, [key]: { ...current, target: value, state: "done", edited: true } };
    });
  };

  const retry = (key: string) => {
    setTranslations((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    runId.current += 1;
    setTranslationRevision((revision) => revision + 1);
  };

  const changeModel = (nextModel: string) => {
    runId.current += 1;
    setModel(nextModel);
    setTranslations({});
    setTranslationRevision((revision) => revision + 1);
  };

  const changeLanguages = (nextSourceLanguage: Language) => {
    runId.current += 1;
    setSourceLanguage(nextSourceLanguage);
    setTargetLanguage(nextSourceLanguage === "en" ? "ko" : "en");
    setTranslations({});
    setTranslationRevision((revision) => revision + 1);
    imageBlocks.forEach((block) => {
      if (block.imageDataUrl) void runOcr(block.id, block.imageDataUrl, nextSourceLanguage);
    });
  };

  const newDocument = () => {
    const hasContent = source.trim() || imageBlocks.length > 0;
    if (hasContent && !window.confirm("현재 문서를 비우고 새로 시작할까요?")) return;
    ocrRuns.current.clear();
    setBlocks([createTextBlock()]);
    setTranslations({});
    setEditingOcrBlockId(null);
  };

  const translatedCount = sentences.filter(({ key }) => translations[key]?.state === "done").length;
  const statusLabel = checking
    ? "연결 확인 중"
    : status?.running && status.modelInstalled
      ? "번역 준비됨"
      : status?.running
        ? "모델 필요"
        : "Ollama 연결 안 됨";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">N</span>
          <div><h1>나란히</h1><p>로컬 병렬 번역 에디터</p></div>
        </div>

        <div className="toolbar">
          <div className="language-settings" aria-label="번역 언어 설정">
            <label className="language-field">
              <span>원문</span>
              <select value={sourceLanguage} onChange={(event) => changeLanguages(event.target.value as Language)}>
                <option value="en">English</option><option value="ko">한국어</option>
              </select>
            </label>
            <span className="language-arrow" aria-hidden="true">→</span>
            <label className="language-field">
              <span>번역</span>
              <select value={targetLanguage} onChange={(event) => changeLanguages(event.target.value === "en" ? "ko" : "en")}>
                <option value="en">English</option><option value="ko">한국어</option>
              </select>
            </label>
          </div>
          <label className="model-field">
            <span>모델</span>
            <select value={model} onChange={(event) => changeModel(event.target.value)}>
              <option value="translategemma:12b-it-q4_K_M">TranslateGemma 12B · 빠름</option>
              <option value="translategemma:12b-it-q8_0">TranslateGemma 12B · 고품질</option>
              <option value="translategemma:27b-it-q4_K_M">TranslateGemma 27B · 최고 품질</option>
            </select>
          </label>
          <button className="secondary-button" type="button" onClick={newDocument}>새 문서</button>
        </div>
      </header>

      <section className={`connection-banner ${status?.running && status.modelInstalled ? "ready" : "warning"}`}>
        <div className="connection-copy">
          <span className="status-dot" /><strong>{statusLabel}</strong>
          {!checking && status && !(status.running && status.modelInstalled) && <span>{status.message}</span>}
        </div>
        {!checking && !(status?.running && status?.modelInstalled) && (
          <button type="button" onClick={() => void checkOllama()}>다시 확인</button>
        )}
      </section>

      <section className="workspace">
        <div className="pane source-pane">
          <div className="pane-heading">
            <div><span className="eyebrow">SOURCE</span><h2>{LANGUAGE_LABELS[sourceLanguage].native}</h2></div>
            <span className="pane-meta">
              {processingOcrCount > 0 ? `OCR ${processingOcrCount}개 인식 중 · ` : ""}
              {words} {sourceLanguage === "en" ? "words" : "어절"} · {sentences.length} sentences
            </span>
          </div>

          <div className="mixed-editor" aria-label={`${LANGUAGE_LABELS[sourceLanguage].native} 원문 문서`}>
            {blocks.map((block, index) => block.type === "text" ? (
              <div className="document-block text-document-block" key={block.id}>
                <textarea
                  ref={(editor) => {
                    if (editor) textEditorRefs.current.set(block.id, editor);
                    else textEditorRefs.current.delete(block.id);
                  }}
                  className="block-text-editor"
                  value={block.text}
                  rows={textAreaRows(block.text)}
                  onChange={(event) => updateTextBlock(block.id, event.target.value)}
                  onPaste={(event) => void handleTextPaste(block.id, event)}
                  placeholder={blocks.length === 1 && index === 0
                    ? sourceLanguage === "en"
                      ? "Start writing in English, or paste an image…"
                      : "한국어로 작성하거나 이미지를 붙여넣으세요…"
                    : "계속 작성하세요…"}
                  spellCheck={sourceLanguage === "en"}
                  lang={sourceLanguage}
                  autoFocus={index === 0}
                  aria-label={`${index + 1}번째 원문 텍스트`}
                />
              </div>
            ) : (
              <div className={`document-block media-document-block ${block.view === "text" ? "showing-text" : "showing-image"}`} key={block.id}>
                {block.view === "image" && block.imageDataUrl ? (
                  <div
                    className="inline-image-block"
                    role="button"
                    tabIndex={0}
                    aria-label={block.ocrState === "done" ? "OCR 텍스트 보기" : "붙여넣은 이미지"}
                    onClick={() => toggleImageBlock(block.id)}
                    onKeyDown={(event) => handleImageKeyDown(block.id, event)}
                  >
                    <img src={block.imageDataUrl} alt="OCR로 인식한 붙여넣은 원문" />
                    {block.ocrState === "processing" && (
                      <div className="inline-ocr-status"><div className="ocr-spinner" /><strong>OCR 인식 중</strong></div>
                    )}
                    {block.ocrState === "error" && (
                      <div className="inline-ocr-status error"><strong>OCR 실패</strong><span>{block.error}</span></div>
                    )}
                    <div className="block-hover-actions">
                      {block.ocrState === "done" && <span>OCR 텍스트 보기</span>}
                      {block.ocrState === "error" && (
                        <button type="button" onClick={(event) => {
                          event.stopPropagation();
                          if (block.imageDataUrl) void runOcr(block.id, block.imageDataUrl);
                        }}>다시 인식</button>
                      )}
                      <button className="danger" type="button" onClick={(event) => {
                        event.stopPropagation();
                        deleteImageBlock(block.id);
                      }}>삭제</button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="inline-ocr-text"
                    role="button"
                    tabIndex={block.imageDataUrl ? 0 : -1}
                    aria-label={block.imageDataUrl ? "이미지 보기" : "저장된 OCR 텍스트"}
                    onClick={() => toggleImageBlock(block.id)}
                    onKeyDown={(event) => handleImageKeyDown(block.id, event)}
                  >
                    <div className="ocr-text-heading">
                      <span>OCR TEXT</span>
                      {block.elapsedMs !== null && <em>{(block.elapsedMs / 1000).toFixed(2)}초</em>}
                      {!block.imageDataUrl && <em>이미지는 현재 실행에서만 보관됩니다</em>}
                    </div>
                    {editingOcrBlockId === block.id ? (
                      <textarea
                        autoFocus
                        value={block.ocrText}
                        rows={textAreaRows(block.ocrText)}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                        onChange={(event) => updateImageBlock(block.id, (current) => ({ ...current, ocrText: event.target.value }))}
                        onBlur={() => setEditingOcrBlockId(null)}
                        aria-label="OCR 텍스트 수정"
                      />
                    ) : (
                      <p>{block.ocrText || "인식된 텍스트가 없습니다."}</p>
                    )}
                    <div className="block-hover-actions">
                      {block.imageDataUrl && <span>이미지 보기</span>}
                      <button type="button" onClick={(event) => {
                        event.stopPropagation();
                        setEditingOcrBlockId(block.id);
                      }}>수정</button>
                      {block.imageDataUrl && (
                        <button type="button" onClick={(event) => {
                          event.stopPropagation();
                          void runOcr(block.id, block.imageDataUrl!);
                        }}>다시 인식</button>
                      )}
                      <button className="danger" type="button" onClick={(event) => {
                        event.stopPropagation();
                        deleteImageBlock(block.id);
                      }}>삭제</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="divider" aria-hidden="true"><span>→</span></div>

        <div className="pane target-pane">
          <div className="pane-heading">
            <div><span className="eyebrow">TRANSLATION</span><h2>{LANGUAGE_LABELS[targetLanguage].native}</h2></div>
            <span className="pane-meta">{translatedCount}/{sentences.length} 완료</span>
          </div>
          <div className={`translation-list ${sentences.length === 0 ? "empty" : ""}`}>
            {sentences.length === 0 ? (
              <div className="empty-state"><span>가</span><p>왼쪽에서 {LANGUAGE_LABELS[sourceLanguage].native} 문장을 작성하면<br />{LANGUAGE_LABELS[targetLanguage].native} 번역이 여기에 나타납니다.</p></div>
            ) : sentences.map((sentence, index) => {
              const translation = translations[sentence.key];
              return (
                <article className="translation-card" key={sentence.key}>
                  <span className="sentence-number">{String(index + 1).padStart(2, "0")}</span>
                  {translation?.state === "done" && translation.elapsedMs !== undefined && (
                    <span className="elapsed-time">{(translation.elapsedMs / 1000).toFixed(2)}초</span>
                  )}
                  {translation?.state === "done" ? (
                    <textarea value={translation.target} onChange={(event) => updateTarget(sentence.key, event.target.value)} aria-label={`${index + 1}번 문장 번역`} lang={targetLanguage} rows={Math.max(2, Math.ceil(translation.target.length / 34))} />
                  ) : translation?.state === "error" ? (
                    <div className="translation-error"><p>번역하지 못했습니다.</p><button type="button" onClick={() => retry(sentence.key)}>다시 번역</button></div>
                  ) : status?.running && status.modelInstalled ? (
                    <div className="translation-loading"><span /><span /><span /><em>번역 중</em></div>
                  ) : (
                    <div className="translation-waiting">Ollama 준비 후 자동으로 번역됩니다.</div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <footer>
        <span>문서는 이 Mac에 자동 저장됩니다.</span>
        <span>{lastSaved ? `${lastSaved.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 저장됨` : "저장 준비 중"}</span>
      </footer>
    </main>
  );
}

export default App;
