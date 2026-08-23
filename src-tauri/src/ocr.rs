#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
#[cfg(target_os = "macos")]
use objc2::AnyThread;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
#[cfg(target_os = "macos")]
use objc2_vision::{
    VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest, VNRequest,
    VNRequestTextRecognitionLevel,
};

#[cfg(target_os = "macos")]
pub fn recognize_image_bytes(image_bytes: &[u8], language: &str) -> Result<String, String> {
    let recognition_language = match language {
        "en" => "en-US",
        "ko" => "ko-KR",
        _ => return Err("OCR에서 지원하지 않는 언어입니다.".to_string()),
    };

    let image_data = NSData::with_bytes(image_bytes);
    let options = NSDictionary::<VNImageOption, AnyObject>::new();
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &image_data,
        &options,
    );

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);
    request.setAutomaticallyDetectsLanguage(false);

    let language = NSString::from_str(recognition_language);
    let languages = NSArray::from_retained_slice(&[language]);
    request.setRecognitionLanguages(&languages);

    let requests = NSArray::<VNRequest>::from_slice(&[request.as_ref()]);
    handler
        .performRequests_error(&requests)
        .map_err(|error| format!("이미지 OCR 처리에 실패했습니다: {error}"))?;

    let observations = request
        .results()
        .ok_or_else(|| "이미지에서 OCR 결과를 가져오지 못했습니다.".to_string())?;

    let lines: Vec<String> = observations
        .iter()
        .filter_map(|observation| {
            let candidates = observation.topCandidates(1);
            candidates
                .iter()
                .next()
                .map(|text| text.string().to_string())
        })
        .filter(|line| !line.trim().is_empty())
        .collect();

    if lines.is_empty() {
        return Err("이미지에서 인식할 수 있는 텍스트를 찾지 못했습니다.".to_string());
    }

    Ok(lines.join("\n"))
}

#[cfg(not(target_os = "macos"))]
pub fn recognize_image_bytes(_image_bytes: &[u8], _language: &str) -> Result<String, String> {
    Err("이미지 OCR은 현재 macOS에서만 지원합니다.".to_string())
}
