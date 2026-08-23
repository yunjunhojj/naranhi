import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getOllamaStatus, OllamaStatus, translateSentence } from "./ollama";
import { countWords, splitSentences } from "./text";

const DEFAULT_MODEL = "translategemma:12b-it-q4_K_M";
const STORAGE_KEY = "parallel-translator-document-v1";

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
  source: string;
  model: string;
  translations: Record<string, Translation>;
};

function loadDocument(): SavedDocument {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved) as SavedDocument;
  } catch {
    // A damaged draft should never prevent the editor from opening.
  }
  return { source: "", model: DEFAULT_MODEL, translations: {} };
}

function App() {
  const initial = useMemo(loadDocument, []);
  const [source, setSource] = useState(initial.source);
  const [model, setModel] = useState(initial.model || DEFAULT_MODEL);
  const [translations, setTranslations] = useState<Record<string, Translation>>(
    initial.translations ?? {}
  );
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [translationRevision, setTranslationRevision] = useState(0);
  const runId = useRef(0);

  const sentences = useMemo(() => splitSentences(source), [source]);
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
      const payload: SavedDocument = { source, model, translations };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      setLastSaved(new Date());
    }, 350);
    return () => window.clearTimeout(timer);
  }, [model, source, translations]);

  useEffect(() => {
    const currentRun = ++runId.current;
    const timer = window.setTimeout(async () => {
      if (!status?.running || !status.modelInstalled) return;

      const pending = sentences.filter((sentence) => {
        const existing = translations[sentence.key];
        return !existing || existing.source !== sentence.text || existing.state === "error";
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
          const result = await translateSentence(sentence.text, model);
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
  }, [model, sentences, status?.modelInstalled, status?.running, translationRevision]);

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

  const newDocument = () => {
    if (source.trim() && !window.confirm("현재 문서를 비우고 새로 시작할까요?")) return;
    setSource("");
    setTranslations({});
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
        <div className="pane source-pane">
          <div className="pane-heading">
            <div>
              <span className="eyebrow">SOURCE</span>
              <h2>English</h2>
            </div>
            <span className="pane-meta">{words} words · {sentences.length} sentences</span>
          </div>
          <textarea
            className="source-editor"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="Start writing in English…"
            spellCheck
            autoFocus
            aria-label="영어 원문"
          />
        </div>

        <div className="divider" aria-hidden="true"><span>→</span></div>

        <div className="pane target-pane">
          <div className="pane-heading">
            <div>
              <span className="eyebrow">TRANSLATION</span>
              <h2>한국어</h2>
            </div>
            <span className="pane-meta">{translatedCount}/{sentences.length} 완료</span>
          </div>

          <div className={`translation-list ${sentences.length === 0 ? "empty" : ""}`}>
            {sentences.length === 0 ? (
              <div className="empty-state">
                <span>가</span>
                <p>왼쪽에서 영어를 작성하면<br />문장별 번역이 여기에 나타납니다.</p>
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
