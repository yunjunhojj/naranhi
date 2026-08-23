import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent
} from "react";
import {
  getOllamaStatus,
  OllamaStatus,
  recognizeImageText,
  translateSentence
} from "./ollama";
import { countWords, Language, splitSentences } from "./text";

const DEFAULT_MODEL = "translategemma:12b-it-q4_K_M";
const STORAGE_KEY = "parallel-translator-document-v1";

const LANGUAGE_LABELS: Record<Language, { native: string }> = {
  en: { native: "English" },
  ko: { native: "한국어" }
};

type TranslationState = "idle" | "queued" | "translating" | "done" | "error";
type SourceView = "image" | "text";
type OcrState = "idle" | "processing" | "done" | "error";

type Translation = {
  source: string;
  target: string;
  state: TranslationState;
  elapsedMs?: number;
  error?: string;
  edited?: boolean;
};

type SavedDocument = {
  source: string;
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

function App() {
  const initial = useMemo(loadDocument, []);
  const [source, setSource] = useState(initial.source);
  const [model, setModel] = useState(initial.model || DEFAULT_MODEL);
  const [sourceLanguage, setSourceLanguage] = useState<Language>(
    initial.sourceLanguage ?? "en"
  );
  const [targetLanguage, setTargetLanguage] = useState<Language>(
    initial.targetLanguage ?? "ko"
  );
  const [translations, setTranslations] = useState<Record<string, Translation>>(
    initial.translations ?? {}
  );
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [translationRevision, setTranslationRevision] = useState(0);
  const [pastedImage, setPastedImage] = useState<string | null>(null);
  const [sourceView, setSourceView] = useState<SourceView>("text");
  const [ocrState, setOcrState] = useState<OcrState>("idle");
  const [ocrElapsedMs, setOcrElapsedMs] = useState<number | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const runId = useRef(0);
  const ocrRunId = useRef(0);
  const previousOcrLanguage = useRef(sourceLanguage);

  const sentences = useMemo(
    () => splitSentences(source, sourceLanguage),
    [source, sourceLanguage]
  );
  const words = useMemo(() => countWords(source), [source]);

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
        model,
        sourceLanguage,
        targetLanguage,
        translations
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      setLastSaved(new Date());
    }, 350);
    return () => window.clearTimeout(timer);
  }, [model, source, sourceLanguage, targetLanguage, translations]);

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
          [sentence.key]: {
            source: sentence.text,
            target: "",
            state: "translating"
          }
        }));

        try {
          const result = await translateSentence(
            sentence.text,
            model,
            sourceLanguage,
            targetLanguage
          );
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
  }, [
    model,
    sentences,
    sourceLanguage,
    status?.modelInstalled,
    status?.running,
    targetLanguage,
    translationRevision
  ]);

  const runOcr = useCallback(
    async (imageDataUrl: string) => {
      const currentRun = ++ocrRunId.current;
      setOcrState("processing");
      setOcrError(null);
      setOcrElapsedMs(null);

      try {
        const result = await recognizeImageText(imageDataUrl, sourceLanguage);
        if (ocrRunId.current !== currentRun) return;

        runId.current += 1;
        setSource(result.text);
        setTranslations({});
        setTranslationRevision((revision) => revision + 1);
        setOcrElapsedMs(result.elapsedMs);
        setOcrState("done");
      } catch (error) {
        if (ocrRunId.current !== currentRun) return;
        setOcrError(error instanceof Error ? error.message : String(error));
        setOcrState("error");
      }
    },
    [sourceLanguage]
  );

  useEffect(() => {
    if (previousOcrLanguage.current === sourceLanguage) return;
    previousOcrLanguage.current = sourceLanguage;
    if (pastedImage) void runOcr(pastedImage);
  }, [pastedImage, runOcr, sourceLanguage]);

  const handlePaste = async (event: ReactClipboardEvent<HTMLDivElement>) => {
    const imageItem = Array.from(event.clipboardData.items).find((item) =>
      item.type.startsWith("image/")
    );
    if (!imageItem) return;

    event.preventDefault();
    const imageFile = imageItem.getAsFile();
    if (!imageFile) return;
    if (imageFile.size > 20 * 1024 * 1024) {
      setOcrState("error");
      setOcrError("이미지는 최대 20MB까지 처리할 수 있습니다.");
      return;
    }

    try {
      const imageDataUrl = await readFileAsDataUrl(imageFile);
      runId.current += 1;
      setSource("");
      setTranslations({});
      setPastedImage(imageDataUrl);
      setSourceView("image");
      void runOcr(imageDataUrl);
    } catch (error) {
      setOcrState("error");
      setOcrError(error instanceof Error ? error.message : String(error));
    }
  };

  const updateTarget = (key: string, value: string) => {
    setTranslations((previous) => {
      const current = previous[key];
      if (!current) return previous;
      return {
        ...previous,
        [key]: { ...current, target: value, state: "done", edited: true }
      };
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

  const changeSourceLanguage = (nextLanguage: Language) => {
    runId.current += 1;
    setSourceLanguage(nextLanguage);
    setTargetLanguage(nextLanguage === "en" ? "ko" : "en");
    if (pastedImage) setSource("");
    setTranslations({});
    setTranslationRevision((revision) => revision + 1);
  };

  const changeTargetLanguage = (nextLanguage: Language) => {
    runId.current += 1;
    setTargetLanguage(nextLanguage);
    setSourceLanguage(nextLanguage === "en" ? "ko" : "en");
    if (pastedImage) setSource("");
    setTranslations({});
    setTranslationRevision((revision) => revision + 1);
  };

  const newDocument = () => {
    if (source.trim() && !window.confirm("현재 문서를 비우고 새로 시작할까요?")) return;
    ocrRunId.current += 1;
    setSource("");
    setTranslations({});
    setPastedImage(null);
    setSourceView("text");
    setOcrState("idle");
    setOcrElapsedMs(null);
    setOcrError(null);
  };

  const translatedCount = sentences.filter(
    ({ key }) => translations[key]?.state === "done"
  ).length;

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
          <div>
            <h1>나란히</h1>
            <p>로컬 병렬 번역 에디터</p>
          </div>
        </div>

        <div className="toolbar">
          <div className="language-settings" aria-label="번역 언어 설정">
            <label className="language-field">
              <span>원문</span>
              <select
                value={sourceLanguage}
                onChange={(event) => changeSourceLanguage(event.target.value as Language)}
              >
                <option value="en">English</option>
                <option value="ko">한국어</option>
              </select>
            </label>
            <span className="language-arrow" aria-hidden="true">→</span>
            <label className="language-field">
              <span>번역</span>
              <select
                value={targetLanguage}
                onChange={(event) => changeTargetLanguage(event.target.value as Language)}
              >
                <option value="en">English</option>
                <option value="ko">한국어</option>
              </select>
            </label>
          </div>
          <label className="model-field">
            <span>모델</span>
            <select value={model} onChange={(event) => changeModel(event.target.value)}>
              <option value="translategemma:12b-it-q4_K_M">TranslateGemma 12B · 빠름</option>
              <option value="translategemma:12b-it-q8_0">TranslateGemma 12B · 고품질</option>
            </select>
          </label>
          <button className="secondary-button" type="button" onClick={newDocument}>
            새 문서
          </button>
        </div>
      </header>

      <section className={`connection-banner ${status?.running && status.modelInstalled ? "ready" : "warning"}`}>
        <div className="connection-copy">
          <span className="status-dot" />
          <strong>{statusLabel}</strong>
          {!checking && status && !(status.running && status.modelInstalled) && (
            <span>{status.message}</span>
          )}
        </div>
        {!checking && !(status?.running && status?.modelInstalled) && (
          <button type="button" onClick={() => void checkOllama()}>다시 확인</button>
        )}
      </section>

      <section className="workspace">
        <div className="pane source-pane" onPaste={(event) => void handlePaste(event)}>
          <div className="pane-heading">
            <div>
              <span className="eyebrow">SOURCE</span>
              <h2>{LANGUAGE_LABELS[sourceLanguage].native}</h2>
            </div>
            <div className="pane-heading-actions">
              <span className="pane-meta">
                {ocrState === "processing"
                  ? "OCR 인식 중"
                  : ocrElapsedMs !== null
                    ? `OCR ${(ocrElapsedMs / 1000).toFixed(2)}초 · `
                    : ""}
                {words} {sourceLanguage === "en" ? "words" : "어절"} · {sentences.length} sentences
              </span>
              {pastedImage && (
                <div className="view-toggle" aria-label="원문 보기 방식">
                  <button
                    className={sourceView === "image" ? "active" : ""}
                    type="button"
                    onClick={() => setSourceView("image")}
                  >
                    이미지
                  </button>
                  <button
                    className={sourceView === "text" ? "active" : ""}
                    type="button"
                    disabled={ocrState !== "done"}
                    onClick={() => setSourceView("text")}
                  >
                    OCR 텍스트
                  </button>
                </div>
              )}
            </div>
          </div>
          {pastedImage && sourceView === "image" ? (
            <div className="image-source-view" tabIndex={0} aria-label="붙여넣은 원문 이미지">
              <img src={pastedImage} alt="OCR로 인식할 붙여넣은 원문" />
              {ocrState === "processing" && (
                <div className="ocr-overlay">
                  <div className="ocr-spinner" />
                  <strong>텍스트를 인식하고 있습니다</strong>
                  <span>Apple Vision · 이 Mac에서 처리 중</span>
                </div>
              )}
              {ocrState === "error" && (
                <div className="ocr-overlay error">
                  <strong>OCR에 실패했습니다</strong>
                  <span>{ocrError}</span>
                  <button type="button" onClick={() => void runOcr(pastedImage)}>다시 인식</button>
                </div>
              )}
              {ocrState === "done" && (
                <div className="image-caption">
                  텍스트 인식 완료 · 상단의 OCR 텍스트를 눌러 확인하세요
                </div>
              )}
            </div>
          ) : (
            <textarea
              className="source-editor"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder={
                sourceLanguage === "en"
                  ? "Start writing in English, or paste an image…"
                  : "한국어로 작성하거나 이미지를 붙여넣으세요…"
              }
              spellCheck={sourceLanguage === "en"}
              lang={sourceLanguage}
              autoFocus
              aria-label={`${LANGUAGE_LABELS[sourceLanguage].native} 원문`}
            />
          )}
        </div>

        <div className="divider" aria-hidden="true"><span>→</span></div>

        <div className="pane target-pane">
          <div className="pane-heading">
            <div>
              <span className="eyebrow">TRANSLATION</span>
              <h2>{LANGUAGE_LABELS[targetLanguage].native}</h2>
            </div>
            <span className="pane-meta">{translatedCount}/{sentences.length} 완료</span>
          </div>

          <div className={`translation-list ${sentences.length === 0 ? "empty" : ""}`}>
            {sentences.length === 0 ? (
              <div className="empty-state">
                <span>가</span>
                <p>
                  왼쪽에서 {LANGUAGE_LABELS[sourceLanguage].native} 문장을 작성하면<br />
                  {LANGUAGE_LABELS[targetLanguage].native} 번역이 여기에 나타납니다.
                </p>
              </div>
            ) : (
              sentences.map((sentence, index) => {
                const translation = translations[sentence.key];
                return (
                  <article className="translation-card" key={sentence.key}>
                    <span className="sentence-number">{String(index + 1).padStart(2, "0")}</span>
                    {translation?.state === "done" && translation.elapsedMs !== undefined && (
                      <span className="elapsed-time">
                        {(translation.elapsedMs / 1000).toFixed(2)}초
                      </span>
                    )}
                    {translation?.state === "done" ? (
                      <textarea
                        value={translation.target}
                        onChange={(event) => updateTarget(sentence.key, event.target.value)}
                        aria-label={`${index + 1}번 문장 번역`}
                        lang={targetLanguage}
                        rows={Math.max(2, Math.ceil(translation.target.length / 34))}
                      />
                    ) : translation?.state === "error" ? (
                      <div className="translation-error">
                        <p>번역하지 못했습니다.</p>
                        <button type="button" onClick={() => retry(sentence.key)}>다시 번역</button>
                      </div>
                    ) : status?.running && status.modelInstalled ? (
                      <div className="translation-loading">
                        <span /><span /><span />
                        <em>번역 중</em>
                      </div>
                    ) : (
                      <div className="translation-waiting">Ollama 준비 후 자동으로 번역됩니다.</div>
                    )}
                  </article>
                );
              })
            )}
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
