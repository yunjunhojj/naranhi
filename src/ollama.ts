import { invoke } from "@tauri-apps/api/core";

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

export async function getOllamaStatus(model: string): Promise<OllamaStatus> {
  return invoke<OllamaStatus>("ollama_status", { model });
}

export async function translateSentence(text: string, model: string): Promise<TranslationResult> {
  return invoke<TranslationResult>("translate_sentence", { text, model });
}
