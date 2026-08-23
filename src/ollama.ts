import { invoke } from "@tauri-apps/api/core";
import type { Language } from "./text";

export type OllamaStatus = {
  running: boolean;
  modelInstalled: boolean;
  installedModels: string[];
  message: string;
};

export type TranslationResult = {
  text: string;
  elapsedMs: number;
};

export type OcrResult = {
  text: string;
  elapsedMs: number;
};

export async function getOllamaStatus(model: string): Promise<OllamaStatus> {
  return invoke<OllamaStatus>("ollama_status", { model });
}

export async function translateSentence(
  text: string,
  model: string,
  sourceLanguage: Language,
  targetLanguage: Language
): Promise<TranslationResult> {
  return invoke<TranslationResult>("translate_sentence", {
    text,
    model,
    sourceLanguage,
    targetLanguage
  });
}

export async function recognizeImageText(
  imageDataUrl: string,
  language: Language
): Promise<OcrResult> {
  return invoke<OcrResult>("recognize_image_text", { imageDataUrl, language });
}
