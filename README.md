# 나란히

Ollama와 TranslateGemma를 사용하는 Tauri + React 기반 로컬 병렬 번역 에디터입니다.

## 준비

1. macOS용 Ollama를 설치하고 실행합니다.
2. 번역 모델을 내려받습니다.

```bash
ollama pull translategemma:12b-it-q4_K_M
```

3. 앱을 실행합니다.

```bash
npm install
npm run tauri dev
```

## 동작

- 왼쪽 영어 원문을 800ms 동안 수정하지 않으면 문장 단위로 번역합니다.
- 번역은 Rust 백엔드가 `127.0.0.1:11434`의 Ollama API로 요청합니다.
- 바뀐 문장만 다시 번역하며, 한국어 결과는 직접 수정할 수 있습니다.
- 작업 내용은 WebView의 로컬 저장소에 자동 저장됩니다.
