use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const MARK_BEGIN: &str = "# >>> codexy managed block >>>";
const MARK_END: &str = "# <<< codexy managed block <<<";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Provider {
    name: String,
    base_url: String,
    api_key: String,
    wire_api: String, // "responses" | "chat"
    models: Vec<String>,
    default_model: Option<String>,
}

fn codex_dir() -> PathBuf {
    dirs::home_dir().expect("no home dir").join(".codex")
}
fn cs_dir() -> PathBuf {
    codex_dir().join("codexy")
}
fn providers_dir() -> PathBuf {
    cs_dir().join("providers")
}
fn catalogs_dir() -> PathBuf {
    cs_dir().join("catalogs")
}
fn active_file() -> PathBuf {
    cs_dir().join("active")
}
fn codex_config_path() -> PathBuf {
    codex_dir().join("config.toml")
}

fn ensure_dirs() -> std::io::Result<()> {
    fs::create_dir_all(providers_dir())?;
    fs::create_dir_all(catalogs_dir())?;
    fs::create_dir_all(codex_dir())?;
    Ok(())
}

fn provider_path(name: &str) -> PathBuf {
    providers_dir().join(format!("{name}.json"))
}

fn load_provider(name: &str) -> std::io::Result<Provider> {
    let raw = fs::read_to_string(provider_path(name))?;
    Ok(serde_json::from_str(&raw).expect("corrupt provider file"))
}

fn save_provider(p: &Provider) -> std::io::Result<()> {
    let raw = serde_json::to_string_pretty(p).unwrap();
    fs::write(provider_path(&p.name), raw)
}

fn list_provider_names() -> Vec<String> {
    let mut out = vec![];
    if let Ok(rd) = fs::read_dir(providers_dir()) {
        for entry in rd.flatten() {
            if let Some(stem) = entry.path().file_stem() {
                out.push(stem.to_string_lossy().to_string());
            }
        }
    }
    out.sort();
    out
}

fn read_line(prompt: &str) -> String {
    print!("{prompt}");
    std::io::stdout().flush().ok();
    let mut s = String::new();
    std::io::stdin().read_line(&mut s).ok();
    s.trim().to_string()
}

/// Reads a line from stdin with input masked as `*` per keystroke, instead
/// of fully hidden. Puts the terminal into raw mode (no echo, no line
/// buffering) for the duration of the prompt and always restores it
/// afterward, including on Ctrl-C. Unix only.
fn read_masked_password(prompt: &str) -> String {
    print!("{prompt}");
    std::io::stdout().flush().ok();

    unsafe {
        let mut term: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(libc::STDIN_FILENO, &mut term) != 0 {
            // Not a real tty (e.g. piped input) — fall back to a plain read.
            let mut s = String::new();
            std::io::stdin().read_line(&mut s).ok();
            println!();
            return s.trim().to_string();
        }
        let orig = term;
        term.c_lflag &= !(libc::ECHO | libc::ICANON);
        libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &term);

        let mut buf: Vec<u8> = Vec::new();
        let mut byte: [u8; 1] = [0];
        loop {
            let n = libc::read(libc::STDIN_FILENO, byte.as_mut_ptr() as *mut _, 1);
            if n <= 0 {
                break;
            }
            match byte[0] {
                b'\n' | b'\r' => break,
                0x7f | 0x08 => {
                    // backspace / delete
                    if buf.pop().is_some() {
                        print!("\u{8} \u{8}");
                        std::io::stdout().flush().ok();
                    }
                }
                0x03 => {
                    // Ctrl-C: restore the terminal before exiting, or the
                    // shell is left with echo disabled afterward.
                    libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &orig);
                    println!();
                    std::process::exit(130);
                }
                c => {
                    buf.push(c);
                    print!("*");
                    std::io::stdout().flush().ok();
                }
            }
        }

        libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &orig);
        println!();
        String::from_utf8_lossy(&buf).trim().to_string()
    }
}

fn active_provider_name() -> Option<String> {
    fs::read_to_string(active_file())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Interactive pick from a list of model ids, with a text filter: typing
/// anything that isn't a comma-separated index list or "a"/"all" narrows
/// the view to ids containing that substring (case-insensitive). "*"
/// resets to the full list. The filter always searches the full list, so
/// typing more text after a filter re-narrows rather than compounds.
fn interactive_pick_from_list(all_ids: &[String]) -> Vec<String> {
    let mut view: Vec<String> = all_ids.to_vec();
    loop {
        if view.len() == all_ids.len() {
            println!("\nModels:");
        } else {
            println!("\nModels (filtered, {} of {}):", view.len(), all_ids.len());
        }
        for (i, id) in view.iter().enumerate() {
            println!("{}) {}", i + 1, id);
        }

        let input = read_line(
            "Pick indices (e.g. \"1,3,4\"), \"a\"/\"all\", type text to filter, \"*\" to reset, or Enter to skip: ",
        );
        if input.is_empty() {
            return vec![];
        }

        let lower = input.to_lowercase();
        if lower == "a" || lower == "all" {
            return view;
        }
        if lower == "*" {
            view = all_ids.to_vec();
            continue;
        }

        let looks_like_indices = input.split(',').all(|t| t.trim().parse::<usize>().is_ok());
        if looks_like_indices {
            let mut picked = vec![];
            for tok in input.split(',') {
                if let Ok(idx) = tok.trim().parse::<usize>() {
                    if idx >= 1 && idx <= view.len() {
                        let id = view[idx - 1].clone();
                        if !picked.contains(&id) {
                            picked.push(id);
                        }
                    }
                }
            }
            if picked.is_empty() {
                println!("No valid selections.");
                continue;
            }
            return picked;
        }

        // Otherwise treat it as a filter — always applied against the full
        // list so you can widen or narrow freely without stacking filters.
        let filtered: Vec<String> = all_ids
            .iter()
            .filter(|id| id.to_lowercase().contains(&lower))
            .cloned()
            .collect();
        if filtered.is_empty() {
            println!("No models match \"{input}\" — filter unchanged.");
        } else {
            view = filtered;
        }
    }
}

/// Fetch + pick models from a provider, then pick a default. Shared by
/// "add new provider" and "change models".
fn pick_models_flow(base_url: &str, api_key: &str) -> (Vec<String>, Option<String>) {
    let mut models: Vec<String> = vec![];

    let fetch = read_line("Fetch model list from this provider now? [Y/n] ");
    if !fetch.to_lowercase().starts_with('n') {
        match ureq::get(&format!("{base_url}/models"))
            .set("Authorization", &format!("Bearer {api_key}"))
            .call()
        {
            Ok(resp) => {
                if let Ok(v) = resp.into_json::<Value>() {
                    let mut ids = vec![];
                    if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
                        for item in arr {
                            if let Some(id) = item.get("id").and_then(|x| x.as_str()) {
                                ids.push(id.to_string());
                            }
                        }
                    }
                    if ids.is_empty() {
                        eprintln!("No models found in response.");
                    } else {
                        models = interactive_pick_from_list(&ids);
                    }
                }
            }
            Err(e) => eprintln!("Could not fetch model list: {e}"),
        }
    }

    if models.is_empty() {
        let manual = read_line("Enter model name(s) manually, comma-separated (or blank): ");
        for tok in manual.split(',') {
            let t = tok.trim();
            if !t.is_empty() {
                models.push(t.to_string());
            }
        }
    }

    let default_model = if models.len() > 1 {
        println!("\nModels added:");
        for (i, m) in models.iter().enumerate() {
            println!("{}) {}", i + 1, m);
        }
        let d = read_line(&format!(
            "Which should be the default? [1-{}] (default: 1): ",
            models.len()
        ));
        let idx = d.parse::<usize>().unwrap_or(1);
        Some(models[idx.saturating_sub(1).min(models.len() - 1)].clone())
    } else {
        models.first().cloned()
    };

    (models, default_model)
}

fn flow_add_provider() {
    println!();
    let name = read_line("Provider name: ");
    if name.is_empty() {
        println!("Name can't be empty.");
        return;
    }
    let name = name.replace(' ', "-");

    if provider_path(&name).exists() {
        let confirm = read_line(&format!("Provider '{name}' already exists. Overwrite? [y/N] "));
        if !confirm.to_lowercase().starts_with('y') {
            return;
        }
    }

    let base_url = read_line("Base URL: ")
        .trim_end_matches('/')
        .to_string();
    if base_url.is_empty() {
        println!("Base URL can't be empty.");
        return;
    }
    let api_key = read_masked_password("API key: ");
    if api_key.is_empty() {
        println!("API key can't be empty.");
        return;
    }

    println!("\nWire mode:");
    println!("1) Responses API (native)");
    println!("2) Chat Completions API (local proxy)");
    let choice = read_line("Choose [1/2] (default: 1): ");
    let wire_api = if choice.trim() == "2" { "chat" } else { "responses" }.to_string();

    let (models, default_model) = pick_models_flow(&base_url, &api_key);

    let provider = Provider {
        name: name.clone(),
        base_url,
        api_key,
        wire_api,
        models,
        default_model,
    };
    save_provider(&provider).unwrap();
    println!("Saved provider '{name}'.");

    let act = read_line("Activate it now? [y/N] ");
    if act.to_lowercase().starts_with('y') {
        fs::write(active_file(), &name).unwrap();
        println!("Activated '{name}'.");
    }
}

fn flow_use(name: &str) {
    if !provider_path(name).exists() {
        println!("No such provider: {name}");
        return;
    }
    fs::write(active_file(), name).unwrap();
    println!("Activated '{name}'.");
}

fn flow_remove(name: &str) {
    let confirm = read_line(&format!("Remove provider '{name}'? [y/N] "));
    if !confirm.to_lowercase().starts_with('y') {
        return;
    }
    fs::remove_file(provider_path(name)).ok();
    fs::remove_file(catalogs_dir().join(format!("{name}.json"))).ok();
    if active_provider_name().as_deref() == Some(name) {
        fs::remove_file(active_file()).ok();
        println!("Removed '{name}' (it was active — no provider active now).");
    } else {
        println!("Removed '{name}'.");
    }
}

fn flow_change_models(name: &str) {
    let mut p = match load_provider(name) {
        Ok(p) => p,
        Err(_) => {
            println!("No such provider: {name}");
            return;
        }
    };
    let (models, default_model) = pick_models_flow(&p.base_url, &p.api_key);
    p.models = models;
    p.default_model = default_model;
    save_provider(&p).unwrap();
    if p.models.is_empty() {
        println!("Updated '{name}' — no models set.");
    } else {
        println!("Updated '{name}'. Models: {}", p.models.len());
    }
}

fn manage_menu() {
    loop {
        let names = list_provider_names();
        if names.is_empty() {
            println!("No providers saved yet.");
            return;
        }
        let active = active_provider_name();

        println!("\n== Providers ==");
        for (i, n) in names.iter().enumerate() {
            let p = load_provider(n).unwrap();
            let mode = if p.wire_api == "chat" { " [chat→proxy]" } else { "" };
            let model_info = match p.models.len() {
                0 => String::new(),
                1 => format!(" ({})", p.models[0]),
                k => format!(" ({k} models, default: {})", p.default_model.clone().unwrap_or_default()),
            };
            let marker = if active.as_deref() == Some(n.as_str()) { "  [active]" } else { "" };
            println!("{}) {n}{mode}{model_info}{marker}", i + 1);
        }
        println!("b) Back");

        let choice = read_line("Select provider number: ");
        if choice == "b" {
            return;
        }
        let idx: usize = match choice.parse() {
            Ok(v) => v,
            Err(_) => {
                println!("Invalid choice.");
                continue;
            }
        };
        if idx < 1 || idx > names.len() {
            println!("Invalid choice.");
            continue;
        }
        let sel = &names[idx - 1];

        println!("\n-- {sel} --");
        println!("1) Activate");
        println!("2) Remove");
        println!("3) Change models");
        println!("b) Back");
        match read_line("Choose: ").as_str() {
            "1" => flow_use(sel),
            "2" => flow_remove(sel),
            "3" => flow_change_models(sel),
            _ => {}
        }
    }
}

fn flow_run_codex() {
    let extra = read_line("Extra args to pass to `codex` (optional): ");
    let args: Vec<String> = if extra.is_empty() {
        vec![]
    } else {
        extra.split_whitespace().map(|s| s.to_string()).collect()
    };
    cmd_codex(args); // never returns — execs `codex` and exits with its status
}

fn main_menu() {
    loop {
        println!("\n===== Codex Provider Switcher =====");
        match active_provider_name() {
            Some(name) => {
                if let Ok(p) = load_provider(&name) {
                    let mode_label = if p.wire_api == "chat" { "chat → local proxy" } else { "responses" };
                    println!("Active provider: {name}");
                    println!("Mode: {mode_label}");
                    match p.models.len() {
                        0 => {}
                        1 => println!("Model: {}", p.models[0]),
                        k => println!("Models: {k} (default: {})", p.default_model.clone().unwrap_or_default()),
                    }
                }
            }
            None => println!("Active provider: (none)"),
        }

        println!("\n1) Manage providers");
        println!("2) Add new provider");
        println!("3) Run codex");
        println!("q) Quit");

        match read_line("> ").as_str() {
            "1" => manage_menu(),
            "2" => flow_add_provider(),
            "3" => flow_run_codex(),
            "q" | "Q" => break,
            _ => println!("Invalid choice."),
        }
    }
}

fn write_catalog(name: &str, models: &[String]) -> Option<PathBuf> {
    if models.is_empty() {
        let _ = fs::remove_file(catalogs_dir().join(format!("{name}.json")));
        return None;
    }
    let entries: Vec<Value> = models
        .iter()
        .enumerate()
        .map(|(i, id)| {
            json!({
                "slug": id, "display_name": id, "description": "Added via codexy",
                "supported_reasoning_levels": [{"effort": "medium", "description": "Medium reasoning effort"}],
                "shell_type": "shell_command", "visibility": "list", "supported_in_api": true,
                "priority": i, "base_instructions": "default", "support_verbosity": false,
                "truncation_policy": {"mode": "bytes", "limit": 10000},
                "experimental_supported_tools": [], "availability_nux": Value::Null, "upgrade": Value::Null
            })
        })
        .collect();
    let path = catalogs_dir().join(format!("{name}.json"));
    fs::write(&path, serde_json::to_string_pretty(&json!({ "models": entries })).unwrap()).unwrap();
    Some(path)
}

fn write_codex_config(
    provider: &Provider,
    effective_base_url: &str,
    catalog_path: Option<&PathBuf>,
) {
    let existing = fs::read_to_string(codex_config_path()).unwrap_or_default();

    let mut stripped = String::new();
    let mut in_block = false;
    for line in existing.lines() {
        if line.trim() == MARK_BEGIN {
            in_block = true;
            continue;
        }
        if line.trim() == MARK_END {
            in_block = false;
            continue;
        }
        if !in_block {
            stripped.push_str(line);
            stripped.push('\n');
        }
    }

    let mut block = String::new();
    block.push_str(MARK_BEGIN);
    block.push('\n');
    if let Some(dm) = &provider.default_model {
        block.push_str(&format!("model = \"{dm}\"\n"));
    }
    if let Some(cp) = catalog_path {
        block.push_str(&format!("model_catalog_json = \"{}\"\n", cp.display()));
    }
    block.push_str("model_provider = \"codexswitch\"\n\n");
    block.push_str("[model_providers.codexswitch]\n");
    block.push_str(&format!("name = \"{}\"\n", provider.name));
    block.push_str(&format!("base_url = \"{effective_base_url}\"\n"));
    block.push_str("wire_api = \"responses\"\n");
    block.push_str("env_key = \"CODEX_SWITCH_API_KEY\"\n");
    block.push_str(MARK_END);
    block.push('\n');

    // Insert before the first TOML table header, else append.
    let mut out = String::new();
    let mut inserted = false;
    for line in stripped.lines() {
        if !inserted && line.trim_start().starts_with('[') {
            out.push_str(&block);
            out.push('\n');
            inserted = true;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !inserted {
        if !out.trim().is_empty() {
            out.push('\n');
        }
        out.push_str(&block);
    }

    fs::write(codex_config_path(), out).unwrap();
}

// ---------- Responses <-> Chat Completions translation ----------

fn text_from_content(content: &Value) -> String {
    match content {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|item| {
                let typ = item.get("type")?.as_str()?;
                if typ == "input_text" || typ == "text" {
                    Some(item.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(""),
        other => other.to_string(),
    }
}

fn responses_input_to_messages(body: &Value) -> Vec<Value> {
    let mut messages = vec![];

    if let Some(instr) = body.get("instructions") {
        let t = text_from_content(instr);
        if !t.is_empty() {
            messages.push(json!({"role": "system", "content": t}));
        }
    }

    match body.get("input") {
        Some(Value::String(s)) => {
            if !s.is_empty() {
                messages.push(json!({"role": "user", "content": s}));
            }
        }
        Some(Value::Array(items)) => {
            for item in items {
                let typ = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match typ {
                    "message" => {
                        let role = item.get("role").and_then(|r| r.as_str()).unwrap_or("user");
                        let content = item.get("content").cloned().unwrap_or(Value::Null);
                        messages.push(json!({"role": role, "content": text_from_content(&content)}));
                    }
                    "function_call_output" => {
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": item.get("call_id").and_then(|x| x.as_str()).unwrap_or(""),
                            "content": item.get("output").map(|o| o.to_string()).unwrap_or_default(),
                        }));
                    }
                    "function_call" => {
                        let call_id = item
                            .get("call_id")
                            .or_else(|| item.get("id"))
                            .and_then(|x| x.as_str())
                            .unwrap_or("");
                        messages.push(json!({
                            "role": "assistant",
                            "content": Value::Null,
                            "tool_calls": [{
                                "id": call_id,
                                "type": "function",
                                "function": {
                                    "name": item.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                                    "arguments": item.get("arguments").and_then(|x| x.as_str()).unwrap_or(""),
                                }
                            }]
                        }));
                    }
                    "input_text" | "text" => {
                        messages.push(json!({
                            "role": "user",
                            "content": item.get("text").and_then(|x| x.as_str()).unwrap_or(""),
                        }));
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }

    messages
}

fn responses_tools_to_chat(tools: Option<&Value>) -> Vec<Value> {
    let mut out = vec![];
    if let Some(Value::Array(arr)) = tools {
        for tool in arr {
            if tool.get("type").and_then(|t| t.as_str()) == Some("function") {
                out.push(json!({
                    "type": "function",
                    "function": {
                        "name": tool.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                        "description": tool.get("description").and_then(|x| x.as_str()).unwrap_or(""),
                        "parameters": tool.get("parameters").cloned().unwrap_or(json!({"type": "object"})),
                    }
                }));
            }
        }
    }
    out
}

fn make_chat_request(body: &Value) -> Value {
    let mut req = json!({
        "model": body.get("model").cloned().unwrap_or(Value::Null),
        "messages": responses_input_to_messages(body),
        "stream": false,
    });

    let tools = responses_tools_to_chat(body.get("tools"));
    if !tools.is_empty() {
        req["tools"] = Value::Array(tools);
    }

    for key in [
        "temperature",
        "top_p",
        "max_output_tokens",
        "max_tokens",
        "stop",
        "presence_penalty",
        "frequency_penalty",
    ] {
        if let Some(v) = body.get(key) {
            req[key] = v.clone();
        }
    }
    if let Some(tc) = body.get("tool_choice") {
        if !tc.is_null() {
            req["tool_choice"] = tc.clone();
        }
    }
    req
}

fn rid(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

fn chat_to_response(chat: &Value, model_fallback: &str) -> Value {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let mut output = vec![];
    if let Some(choices) = chat.get("choices").and_then(|c| c.as_array()) {
        if let Some(first) = choices.first() {
            let msg = first.get("message").cloned().unwrap_or(json!({}));
            if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
                if !text.is_empty() {
                    output.push(json!({
                        "id": rid("msg"),
                        "type": "message",
                        "status": "completed",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": text, "annotations": []}],
                    }));
                }
            }
            if let Some(tool_calls) = msg.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in tool_calls {
                    let func = tc.get("function").cloned().unwrap_or(json!({}));
                    let call_id = tc.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()).unwrap_or_else(|| rid("call"));
                    output.push(json!({
                        "id": call_id.clone(),
                        "type": "function_call",
                        "status": "completed",
                        "call_id": call_id,
                        "name": func.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                        "arguments": func.get("arguments").and_then(|x| x.as_str()).unwrap_or("{}"),
                    }));
                }
            }
        }
    }

    let usage = chat.get("usage").cloned().unwrap_or(json!({}));
    json!({
        "id": rid("resp"),
        "object": "response",
        "created_at": now,
        "status": "completed",
        "model": chat.get("model").cloned().unwrap_or(json!(model_fallback)),
        "output": output,
        "parallel_tool_calls": true,
        "tool_choice": "auto",
        "temperature": Value::Null,
        "top_p": Value::Null,
        "usage": {
            "input_tokens": usage.get("prompt_tokens").cloned().unwrap_or(json!(0)),
            "output_tokens": usage.get("completion_tokens").cloned().unwrap_or(json!(0)),
            "total_tokens": usage.get("total_tokens").cloned().unwrap_or(json!(0)),
        }
    })
}

fn sse_event(event_type: &str, mut payload: Value) -> String {
    payload["type"] = json!(event_type);
    format!("event: {event_type}\ndata: {}\n\n", payload)
}

fn build_sse_body(response: &Value) -> String {
    let mut body = String::new();
    body.push_str(&sse_event("response.created", json!({"response": response})));

    let output = response.get("output").and_then(|o| o.as_array()).cloned().unwrap_or_default();
    for (idx, item) in output.iter().enumerate() {
        body.push_str(&sse_event(
            "response.output_item.added",
            json!({"item": item, "output_index": idx}),
        ));
        if item.get("type").and_then(|t| t.as_str()) == Some("message") {
            let content0 = item
                .get("content")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .cloned()
                .unwrap_or(json!({}));
            let text = content0.get("text").and_then(|t| t.as_str()).unwrap_or("");
            let item_id = item.get("id").cloned().unwrap_or(Value::Null);
            body.push_str(&sse_event(
                "response.content_part.added",
                json!({
                    "item_id": item_id, "output_index": idx, "content_index": 0,
                    "part": {"type": "output_text", "text": "", "annotations": []}
                }),
            ));
            if !text.is_empty() {
                body.push_str(&sse_event(
                    "response.output_text.delta",
                    json!({"item_id": item_id, "output_index": idx, "content_index": 0, "delta": text}),
                ));
            }
            body.push_str(&sse_event(
                "response.output_text.done",
                json!({"item_id": item_id, "output_index": idx, "content_index": 0, "text": text}),
            ));
        }
    }
    body.push_str(&sse_event("response.completed", json!({"response": response})));
    body.push_str("data: [DONE]\n\n");
    body
}

fn call_upstream(base_url: &str, api_key: &str, chat_req: &Value) -> Result<Value, String> {
    let url = format!("{base_url}/chat/completions");
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_json(chat_req.clone());

    match resp {
        Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            Err(format!("upstream {code}: {body}"))
        }
        Err(e) => Err(e.to_string()),
    }
}

fn run_proxy_server(listener: TcpListener, base_url: String, api_key: String, shutdown: Arc<AtomicBool>) {
    let server = tiny_http::Server::from_listener(listener, None).unwrap();
    loop {
        if shutdown.load(Ordering::Relaxed) {
            return;
        }
        let request = match server.recv_timeout(std::time::Duration::from_millis(300)) {
            Ok(Some(r)) => r,
            Ok(None) => continue,
            Err(_) => continue,
        };

        let url = request.url().to_string();
        let method = request.method().clone();

        if method != tiny_http::Method::Post || !(url == "/responses" || url == "/v1/responses") {
            let response = tiny_http::Response::from_string("{\"error\":{\"message\":\"Not found\"}}")
                .with_status_code(404);
            let _ = request.respond(response);
            continue;
        }

        let mut request = request;
        let mut raw = String::new();
        if request.as_reader().read_to_string(&mut raw).is_err() {
            let response = tiny_http::Response::from_string("{\"error\":{\"message\":\"bad body\"}}")
                .with_status_code(400);
            let _ = request.respond(response);
            continue;
        }

        let body: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                let response = tiny_http::Response::from_string(format!(
                    "{{\"error\":{{\"message\":\"Invalid JSON: {e}\"}}}}"
                ))
                .with_status_code(400);
                let _ = request.respond(response);
                continue;
            }
        };

        let model = body.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
        let stream = body.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
        let chat_req = make_chat_request(&body);

        match call_upstream(&base_url, &api_key, &chat_req) {
            Ok(chat) => {
                let response = chat_to_response(&chat, &model);
                if stream {
                    let sse = build_sse_body(&response);
                    let header = tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"text/event-stream"[..],
                    )
                    .unwrap();
                    let resp = tiny_http::Response::from_string(sse).with_header(header);
                    let _ = request.respond(resp);
                } else {
                    let header = tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"application/json"[..],
                    )
                    .unwrap();
                    let resp = tiny_http::Response::from_string(response.to_string()).with_header(header);
                    let _ = request.respond(resp);
                }
            }
            Err(e) => {
                let resp = tiny_http::Response::from_string(format!(
                    "{{\"error\":{{\"message\":\"Proxy translation error: {e}\"}}}}"
                ))
                .with_status_code(502);
                let _ = request.respond(resp);
            }
        }
    }
}

fn cmd_codex(extra_args: Vec<String>) {
    ensure_dirs().unwrap();
    let active = match fs::read_to_string(active_file()) {
        Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => {
            eprintln!("No active provider. Run `codexy add` then `codexy use <name>` first.");
            std::process::exit(1);
        }
    };
    let provider = match load_provider(&active) {
        Ok(p) => p,
        Err(_) => {
            eprintln!("Active provider '{active}' not found on disk.");
            std::process::exit(1);
        }
    };

    let catalog_path = write_catalog(&provider.name, &provider.models);

    let effective_base_url: String;
    let mut shutdown = None;
    let mut server_thread = None;

    if provider.wire_api == "chat" {
        let listener = TcpListener::bind("127.0.0.1:0").expect("could not bind local proxy port");
        let port = listener.local_addr().unwrap().port();
        effective_base_url = format!("http://127.0.0.1:{port}/v1");

        let flag = Arc::new(AtomicBool::new(false));
        shutdown = Some(flag.clone());
        let base_url = provider.base_url.clone();
        let api_key = provider.api_key.clone();
        server_thread = Some(std::thread::spawn(move || {
            run_proxy_server(listener, base_url, api_key, flag);
        }));
        eprintln!("codexy: local translation proxy running on 127.0.0.1:{port} -> {}", provider.base_url);
    } else {
        effective_base_url = provider.base_url.clone();
    }

    write_codex_config(&provider, &effective_base_url, catalog_path.as_ref());

    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("CODEX_SWITCH_API_KEY".to_string(), provider.api_key.clone());

    eprintln!("codexy: launching `codex` with provider '{}' ({})", provider.name, provider.wire_api);
    let status = Command::new("codex")
        .args(&extra_args)
        .envs(&env)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();

    if let Some(flag) = shutdown {
        flag.store(true, Ordering::Relaxed);
    }
    if let Some(t) = server_thread {
        let _ = t.join();
    }

    match status {
        Ok(s) => std::process::exit(s.code().unwrap_or(1)),
        Err(e) => {
            eprintln!("codexy: failed to launch `codex`: {e}");
            eprintln!("Is the `codex` binary on your PATH?");
            std::process::exit(1);
        }
    }
}

fn main() {
    ensure_dirs().ok();
    main_menu();
}
