mod project;
mod semantic;
use anyhow::{Context, Result, bail};
use project::Project;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{BufRead, Read, Write},
    path::PathBuf,
};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const ENGINE: &str = "0.0.358";

fn read_message(input: &mut impl BufRead) -> Result<Option<Value>> {
    let mut length = None;
    let mut headers = 0;
    loop {
        let mut line = Vec::new();
        let bytes = (&mut *input).take(8193).read_until(b'\n', &mut line)?;
        if bytes == 0 {
            if headers == 0 {
                return Ok(None);
            }
            bail!("Truncated JSON-RPC headers");
        }
        headers += bytes;
        if headers > 8192 {
            bail!("JSON-RPC headers exceed 8192 bytes");
        }
        let line = std::str::from_utf8(&line)?.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').context("Invalid JSON-RPC header")?;
        if name.eq_ignore_ascii_case("Content-Length") {
            if length.is_some() {
                bail!("Duplicate Content-Length");
            }
            length = Some(value.trim().parse::<usize>()?);
        }
    }
    let length = length.context("Missing Content-Length")?;
    if length > MAX_BYTES {
        bail!("JSON-RPC message exceeds 16 MiB");
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}

fn send(output: &mut impl Write, message: Value) -> Result<()> {
    let bytes = serde_json::to_vec(&message)?;
    if bytes.len() > MAX_BYTES {
        bail!("Rust type response exceeds 16 MiB; reduce --limit");
    }
    write!(output, "Content-Length: {}\r\n\r\n", bytes.len())?;
    output.write_all(&bytes)?;
    output.flush()?;
    Ok(())
}

fn file(uri: &str) -> Result<PathBuf> {
    let url = url::Url::parse(uri)?;
    if url.scheme() != "file" || url.query().is_some() || url.fragment().is_some() {
        bail!("Expected a local file URI");
    }
    Ok(std::fs::canonicalize(
        url.to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid file URI"))?,
    )?)
}

#[derive(Deserialize)]
struct Query {
    uri: String,
    range: Option<semantic::Range>,
    symbol: Option<String>,
    view: String,
    limit: usize,
}

fn serve(input: &mut impl BufRead, output: &mut impl Write) -> Result<()> {
    let root = std::env::current_dir()?;
    let mut settings = json!({});
    let mut project: Option<Project> = None;
    let mut revision: u64 = 0;
    let mut documents = BTreeMap::<PathBuf, String>::new();
    let mut stopped = false;
    while let Some(message) = read_message(input)? {
        let id = message.get("id").cloned();
        let method = message["method"].as_str().unwrap_or("");
        let params = &message["params"];
        let result = (|| -> Result<Value> {
            if stopped && method != "exit" {
                bail!("Rust type backend is shutting down");
            }
            match method {
                "initialize" => {
                    settings = params["initializationOptions"].clone();
                    Ok(
                        json!({"capabilities":{"textDocumentSync":1,"codexTypesVersion":1},"serverInfo":{"name":"codex-lsp-rust-types","version":env!("CARGO_PKG_VERSION")}}),
                    )
                }
                "initialized" => Ok(Value::Null),
                "textDocument/didOpen" | "textDocument/didChange" => {
                    let path = file(
                        params["textDocument"]["uri"]
                            .as_str()
                            .context("Missing document URI")?,
                    )?;
                    let text = if method.ends_with("didOpen") {
                        params["textDocument"]["text"].as_str()
                    } else {
                        params["contentChanges"][0]["text"].as_str()
                    }
                    .context("Missing Rust document text")?;
                    if text.len() > MAX_BYTES {
                        bail!("Rust document exceeds 16 MiB");
                    }
                    documents.insert(path, text.to_owned());
                    Ok(Value::Null)
                }
                "textDocument/didClose" => {
                    documents.remove(&file(
                        params["textDocument"]["uri"]
                            .as_str()
                            .context("Missing document URI")?,
                    )?);
                    Ok(Value::Null)
                }
                "codex/types" => {
                    let request: Query = serde_json::from_value(params.clone())?;
                    if !["computed", "declared", "expected"].contains(&request.view.as_str()) {
                        bail!("Invalid Rust type view");
                    }
                    let path = file(&request.uri)?;
                    let opened = documents.get(&path).context("Rust document is not open")?;
                    if std::fs::read_to_string(&path)? != *opened {
                        return Err(anyhow::anyhow!("Source changed during Rust query")
                            .context("ContentModified"));
                    }
                    let reload = project
                        .as_ref()
                        .map(|project| project.changed())
                        .transpose()?
                        .unwrap_or(true);
                    if reload {
                        project = Some(Project::load(&root, &settings)?);
                        revision += 1;
                    }
                    let current = project.as_ref().unwrap();
                    let file_id = current.file(&path)?;
                    let (range, mut result) = match (&request.symbol, request.range) {
                        (None, Some(range)) => (Some(range), None),
                        (Some(symbol), None) => {
                            let mut candidates =
                                semantic::lookup(&current.db, file_id, opened, symbol);
                            if candidates.len() == 1 {
                                let point = candidates.remove(0).0;
                                (
                                    Some(semantic::Range {
                                        start: point,
                                        end: point,
                                    }),
                                    None,
                                )
                            } else {
                                let count = candidates.len();
                                let maximum = if request.limit == 0 {
                                    200
                                } else {
                                    request.limit.min(200)
                                };
                                let rows:Vec<_>=candidates.into_iter().take(maximum).map(|(point,name)|json!({"file":path,"line":point.line+1,"column":point.character+1,"symbol":name})).collect();
                                (
                                    None,
                                    Some(
                                        json!({"success":false,"found":false,"summary":"No unique Rust declaration","type":null,"reason":if count==0{"symbol-not-found"}else{"ambiguous-symbol"},"candidates":rows,"total":count,"hint":"Select a unique declaration with --line/--column, qualify its module/type name, or inspect an explicit use site"}),
                                    ),
                                )
                            }
                        }
                        _ => bail!("Choose Rust source range or declaration symbol"),
                    };
                    if let Some(range) = range {
                        result = Some(semantic::query(
                            &current.db,
                            file_id,
                            opened,
                            range,
                            &request.view,
                            request.limit,
                        )?);
                    }
                    let mut result = result.unwrap();
                    if current.changed()? || std::fs::read_to_string(&path)? != *opened {
                        bail!(
                            "ContentModified: Rust source, dependency or configuration changed during analysis"
                        );
                    }
                    revision += 1;
                    if result.get("success").is_none() {
                        result["success"] = true.into();
                    }
                    result["supported"] = true.into();
                    result["provider"] = "rust-analyzer-api".into();
                    result["server"] = "rust-analyzer-api".into();
                    result["engineVersion"] = ENGINE.into();
                    result["backendVersion"] = env!("CARGO_PKG_VERSION").into();
                    result["apiVersion"] = 1.into();
                    result["view"] = request.view.into();
                    result["snapshot"] = revision.into();
                    result["reloaded"] = reload.into();
                    if let Some(range) = range {
                        result["cursor"] =
                            json!({"line":range.start.line+1,"column":range.start.character+1});
                    }
                    result["analysis"] = json!({"buildScripts":false,"procMacros":false,"features":settings["cargo"]["features"],"noDefaultFeatures":settings["cargo"]["noDefaultFeatures"],"target":settings["cargo"]["target"]});
                    Ok(result)
                }
                "shutdown" => {
                    project = None;
                    stopped = true;
                    Ok(Value::Null)
                }
                "exit" => {
                    stopped = true;
                    Ok(Value::Null)
                }
                _ => bail!("Unsupported Rust backend request: {method}"),
            }
        })();
        if let Some(id) = id {
            let response = match result {
                Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                Err(error) => {
                    let text = format!("{error:#}");
                    let code = if text.contains("ContentModified") {
                        -32801
                    } else if text.starts_with("Unsupported Rust backend request") {
                        -32601
                    } else {
                        -32603
                    };
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":text}})
                }
            };
            send(output, response)?;
        }
        if method == "exit" {
            break;
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    if std::env::args().any(|argument| argument == "--version") {
        println!(
            "codex-lsp-rust-types {} (rust-analyzer {})",
            env!("CARGO_PKG_VERSION"),
            ENGINE
        );
        return Ok(());
    }
    serve(
        &mut std::io::BufReader::new(std::io::stdin().lock()),
        &mut std::io::stdout().lock(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_framing_rejects_oversized_duplicate_and_truncated_messages() {
        for bytes in [
            b"Content-Length: 1\r\nContent-Length: 1\r\n\r\n0".as_slice(),
            b"Content-Length: 16777217\r\n\r\n",
            b"Content-Length: 9\r\n\r\n{}",
        ] {
            assert!(read_message(&mut std::io::Cursor::new(bytes)).is_err());
        }
        let mut output = Vec::new();
        send(&mut output, json!({"text":"😀中文"})).unwrap();
        assert_eq!(
            read_message(&mut std::io::Cursor::new(output))
                .unwrap()
                .unwrap()["text"],
            "😀中文"
        );
    }
}
