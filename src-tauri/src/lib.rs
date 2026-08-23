mod ocr;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const OLLAMA_URL: &str = "http://127.0.0.1:11434";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OllamaStatus {
    running: bool,
    model_installed: bool,
    installed_models: Vec<String>,
    message: String,
}

#[derive(Debug, Deserialize)]
struct TagsResponse {
    models: Vec<ModelInfo>,
}

#[derive(Debug, Deserialize)]
struct ModelInfo {
    name: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    keep_alive: String,
    options: ChatOptions,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct ChatOptions {
    temperature: f32,
    num_ctx: u32,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    message: ChatMessage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslationResult {
    text: String,
    elapsed_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OcrResult {
    text: String,
    elapsed_ms: u128,
}

fn client(timeout_seconds: u64) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(timeout_seconds))
        .build()
        .map_err(|error| format!("HTTP 클라이언트를 만들지 못했습니다: {error}"))
}

fn model_matches(installed: &str, requested: &str) -> bool {
    installed.eq_ignore_ascii_case(requested)
        || installed
            .strip_suffix(":latest")
            .is_some_and(|name| name.eq_ignore_ascii_case(requested))
        || requested
            .strip_suffix(":latest")
            .is_some_and(|name| name.eq_ignore_ascii_case(installed))
}

#[tauri::command]
async fn ollama_status(model: String) -> Result<OllamaStatus, String> {
    let response = match client(8)?
        .get(format!("{OLLAMA_URL}/api/tags"))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return Ok(OllamaStatus {
                running: false,
                model_installed: false,
                installed_models: vec![],
                message: "Ollama 앱을 실행해 주세요.".to_string(),
            })
        }
    };

    if !response.status().is_success() {
        return Ok(OllamaStatus {
            running: false,
            model_installed: false,
            installed_models: vec![],
            message: format!("Ollama가 HTTP {}를 반환했습니다.", response.status()),
        });
    }

    let body = response
        .json::<TagsResponse>()
        .await
        .map_err(|error| format!("Ollama 응답을 읽지 못했습니다: {error}"))?;
    let installed_models: Vec<String> = body.models.into_iter().map(|item| item.name).collect();
    let model_installed = installed_models
        .iter()
        .any(|installed| model_matches(installed, &model));

    let message = if model_installed {
        "로컬 모델이 준비되었습니다.".to_string()
    } else {
        format!("터미널에서 `ollama pull {model}`을 실행해 주세요.")
    };

    Ok(OllamaStatus {
        running: true,
        model_installed,
        installed_models,
        message,
    })
}

#[tauri::command]
async fn translate_sentence(
    text: String,
    model: String,
    source_language: String,
    target_language: String,
) -> Result<TranslationResult, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(TranslationResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }
    if text.chars().count() > 4_000 {
        return Err("한 번에 번역할 문장이 너무 깁니다.".to_string());
    }

    let (source_name, source_code) = match source_language.as_str() {
        "en" => ("English", "en"),
        "ko" => ("Korean", "ko"),
        _ => return Err("지원하지 않는 원문 언어입니다.".to_string()),
    };
    let (target_name, target_code) = match target_language.as_str() {
        "en" => ("English", "en"),
        "ko" => ("Korean", "ko"),
        _ => return Err("지원하지 않는 번역 언어입니다.".to_string()),
    };
    if source_code == target_code {
        return Err("원문 언어와 번역 언어는 달라야 합니다.".to_string());
    }

    let prompt = format!(
        "You are a professional {source_name} ({source_code}) to {target_name} ({target_code}) translator. Your goal is to accurately convey the meaning and nuances of the original {source_name} text while adhering to {target_name} grammar, vocabulary, and cultural sensitivities.\nProduce only the {target_name} translation, without any additional explanations or commentary. Please translate the following {source_name} text into {target_name}:\n\n\n{text}"
    );

    let request = ChatRequest {
        model,
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: prompt,
        }],
        stream: false,
        keep_alive: "30m".to_string(),
        options: ChatOptions {
            temperature: 0.1,
            num_ctx: 2048,
        },
    };

    let started_at = Instant::now();
    let response = client(180)?
        .post(format!("{OLLAMA_URL}/api/chat"))
        .json(&request)
        .send()
        .await
        .map_err(|error| format!("Ollama에 연결하지 못했습니다: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        let details = response.text().await.unwrap_or_default();
        return Err(format!("번역 요청 실패 ({status}): {details}"));
    }

    let body = response
        .json::<ChatResponse>()
        .await
        .map_err(|error| format!("번역 응답을 읽지 못했습니다: {error}"))?;

    let translation = body.message.content.trim().to_string();
    if translation.is_empty() {
        return Err("모델이 빈 번역을 반환했습니다.".to_string());
    }

    Ok(TranslationResult {
        text: translation,
        elapsed_ms: started_at.elapsed().as_millis(),
    })
}

#[tauri::command]
fn recognize_image_text(image_data_url: String, language: String) -> Result<OcrResult, String> {
    const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

    let (metadata, encoded) = image_data_url
        .split_once(',')
        .ok_or_else(|| "올바른 이미지 데이터가 아닙니다.".to_string())?;
    if !metadata.starts_with("data:image/") || !metadata.ends_with(";base64") {
        return Err("지원하지 않는 이미지 데이터 형식입니다.".to_string());
    }
    if encoded.len() > MAX_IMAGE_BYTES * 4 / 3 + 4 {
        return Err("이미지는 최대 20MB까지 처리할 수 있습니다.".to_string());
    }

    let image_bytes = BASE64
        .decode(encoded)
        .map_err(|_| "이미지 데이터를 읽지 못했습니다.".to_string())?;
    if image_bytes.len() > MAX_IMAGE_BYTES {
        return Err("이미지는 최대 20MB까지 처리할 수 있습니다.".to_string());
    }

    let started_at = Instant::now();
    let text = ocr::recognize_image_bytes(&image_bytes, &language)?;

    Ok(OcrResult {
        text,
        elapsed_ms: started_at.elapsed().as_millis(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ollama_status,
            translate_sentence,
            recognize_image_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Tauri application");
}
