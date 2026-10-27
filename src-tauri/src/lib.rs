use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 发给前端的流式分片
#[derive(Clone, Serialize)]
struct StreamChunk {
    text: String,
}

/// 发给前端的错误
#[derive(Clone, Serialize)]
struct StreamError {
    message: String,
}

const SYSTEM_PROMPT: &str =
    "你是一名专业的中文辩论教练，擅长把辩词改写得更有说服力、更贴合赛制语境。只输出改写后的正文，不要解释、不要加引号、不要输出 Markdown 代码块。";

/// 把 base_url 规范化成 chat/completions 端点
fn endpoint_of(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("请先在「接口设置」里填写 Base URL".into());
    }
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Base URL 需要以 https:// 或 http:// 开头".into());
    }
    if trimmed.ends_with("/chat/completions") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{trimmed}/chat/completions"))
    }
}

fn http_error_text(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "请求超时，请检查网络或 Base URL".to_string()
    } else if err.is_connect() {
        "无法连接到接口地址，请检查 Base URL 与网络".to_string()
    } else {
        format!("请求失败：{err}")
    }
}

/// 真正的流式请求：解析 SSE，把 delta.content 逐块 emit 给前端。
/// 这里不打印 api_key，也不打印完整请求体。
async fn run_stream(
    base_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    app: &AppHandle,
) -> Result<(), String> {
    let endpoint = endpoint_of(base_url)?;

    if api_key.trim().is_empty() {
        return Err("请先在「接口设置」里填写 API Key".into());
    }
    if model.trim().is_empty() {
        return Err("请先在「接口设置」里填写模型名称".into());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // 单次生成的整体上限，避免连接挂死；正常流式输出远小于这个时长
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|err| format!("初始化 HTTP 客户端失败：{err}"))?;

    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "temperature": 0.7,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": prompt }
        ]
    });

    let response = client
        .post(&endpoint)
        .bearer_auth(api_key)
        .header("Accept", "text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(|err| http_error_text(&err))?;

    let status = response.status();
    if !status.is_success() {
        // 错误响应通常很短；截断后再回给前端，避免刷屏
        let text = response.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        return Err(format!("接口返回 {status}：{snippet}"));
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|err| format!("读取流失败：{err}"))?;
        buffer.extend_from_slice(&chunk);

        // 按行切分 SSE；用字节缓冲以应对多字节字符被切断的情况
        while let Some(pos) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();

            if data == "[DONE]" {
                let _ = app.emit("stream-done", ());
                return Ok(());
            }

            let Ok(payload) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };

            if let Some(message) = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(|message| message.as_str())
            {
                return Err(format!("接口返回错误：{message}"));
            }

            if let Some(text) = payload["choices"][0]["delta"]["content"].as_str() {
                if !text.is_empty() {
                    let _ = app.emit(
                        "stream-chunk",
                        StreamChunk {
                            text: text.to_string(),
                        },
                    );
                }
            }
        }
    }

    // 服务端没发 [DONE] 就直接结束：按正常收尾处理
    let _ = app.emit("stream-done", ());
    Ok(())
}

/// 流式调用 OpenAI 兼容的 /chat/completions。
/// 所有网络请求都走 Rust，前端不直接 fetch。
#[tauri::command(rename_all = "camelCase")]
async fn stream_completion(
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    app: AppHandle,
) -> Result<(), String> {
    let outcome = run_stream(&base_url, &api_key, &model, &prompt, &app).await;

    if let Err(message) = &outcome {
        let _ = app.emit(
            "stream-error",
            StreamError {
                message: message.clone(),
            },
        );
    }

    outcome
}

/* ==========================================================================
 * PPT → PDF（本地 LibreOffice 无头转换）
 * ========================================================================== */

const CONVERT_HINT: &str = "请确认已安装 LibreOffice，或手动将 PPT 导出为 PDF 后导入";

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn find_soffice() -> Option<PathBuf> {
    for name in ["soffice.exe", "soffice"] {
        if let Some(found) = find_in_path(name) {
            return Some(found);
        }
    }
    [
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|candidate| candidate.is_file())
}

/// 缓存键 = 路径 + 文件大小 + 修改时间，避免源文件变了还命中旧缓存
fn cache_key(path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    if let Ok(meta) = fs::metadata(path) {
        meta.len().hash(&mut hasher);
        if let Ok(modified) = meta.modified() {
            if let Ok(since) = modified.duration_since(std::time::UNIX_EPOCH) {
                since.as_secs().hash(&mut hasher);
                since.subsec_nanos().hash(&mut hasher);
            }
        }
    }
    format!("{:016x}", hasher.finish())
}

fn convert_blocking(pptx_path: &str, app: &AppHandle) -> Result<Vec<u8>, String> {
    let source = PathBuf::from(pptx_path);
    if !source.is_file() {
        return Err("找不到这个 PPT 文件".to_string());
    }

    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| CONVERT_HINT.to_string())?
        .join("ppt-cache");
    fs::create_dir_all(&cache_dir).map_err(|_| CONVERT_HINT.to_string())?;

    let cache_file = cache_dir.join(format!("{}.pdf", cache_key(&source)));
    if cache_file.is_file() {
        if let Ok(bytes) = fs::read(&cache_file) {
            if !bytes.is_empty() {
                return Ok(bytes);
            }
        }
    }

    let soffice = find_soffice().ok_or_else(|| CONVERT_HINT.to_string())?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let work_dir =
        std::env::temp_dir().join(format!("cizhilou-pptx-{}-{}", std::process::id(), stamp));
    fs::create_dir_all(&work_dir).map_err(|_| CONVERT_HINT.to_string())?;

    // 独立的 LibreOffice profile，避免和用户正在用的实例抢锁
    let profile_dir = work_dir.join("profile");
    fs::create_dir_all(&profile_dir).map_err(|_| CONVERT_HINT.to_string())?;
    let profile_url = format!(
        "file:///{}",
        profile_dir.to_string_lossy().replace('\\', "/")
    );

    let mut child = Command::new(&soffice)
        .arg(format!("-env:UserInstallation={profile_url}"))
        .arg("--headless")
        .arg("--norestore")
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(&work_dir)
        .arg(&source)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| CONVERT_HINT.to_string())?;

    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                thread::sleep(Duration::from_millis(120));
            }
            Err(_) => {
                let _ = child.kill();
                break;
            }
        }
    }

    let stem = source
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let produced = work_dir.join(format!("{stem}.pdf"));

    let bytes = if produced.is_file() {
        fs::read(&produced).ok().filter(|data| !data.is_empty())
    } else {
        None
    };

    let _ = fs::remove_dir_all(&work_dir);

    let bytes = bytes.ok_or_else(|| CONVERT_HINT.to_string())?;

    // 写缓存失败不影响本次返回
    let _ = fs::write(&cache_file, &bytes);
    Ok(bytes)
}

/// 用本机 LibreOffice 把 pptx 转成 PDF，返回 PDF 字节。
/// 同一份文件（路径 + 大小 + mtime）会命中 appDataDir/ppt-cache 下的缓存。
#[tauri::command]
async fn convert_pptx_to_pdf(pptx_path: String, app: AppHandle) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || convert_blocking(&pptx_path, &app))
        .await
        .map_err(|_| CONVERT_HINT.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            stream_completion,
            convert_pptx_to_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
