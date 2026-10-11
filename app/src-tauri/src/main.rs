#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop shell for Klosti. The engine runs as a sidecar that serves the app on localhost;
//! this shell shows it in a window, keeps it alive in the menu bar, and turns changes into notifications.

use std::sync::Mutex;

use serde_json::Value;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const MAIN_WINDOW: &str = "main";
const ENGINE_SIDECAR: &str = "klosti-engine";
const READY_MARKER: &str = "running at ";
const NOTIFY_NAME_LIMIT: usize = 3;

/** The running engine, so it can be stopped when the app quits. */
struct Engine(Mutex<Option<CommandChild>>);

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn run_in_page(app: &AppHandle, script: &str) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.eval(script);
    }
}

fn describe(label: &str, names: &[Value]) -> Option<String> {
    if names.is_empty() {
        return None;
    }
    let shown: Vec<&str> = names.iter().filter_map(Value::as_str).take(NOTIFY_NAME_LIMIT).collect();
    let more = names.len().saturating_sub(NOTIFY_NAME_LIMIT);
    let extra = if more > 0 { format!(" +{more}") } else { String::new() };
    Some(format!("{} {label}: {}{extra}", names.len(), shown.join(", ")))
}

/** The engine prints one JSON line per change it notices while watching. */
fn notify_change(app: &AppHandle, line: &str) {
    let Ok(event) = serde_json::from_str::<Value>(line) else { return };
    if event.get("event").and_then(Value::as_str) != Some("changed") {
        return;
    }
    let list = |key: &str| event.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let parts: Vec<String> = [("new", list("added")), ("updated", list("changed")), ("removed", list("removed"))]
        .iter()
        .filter_map(|(label, names)| describe(label, names))
        .collect();
    if parts.is_empty() {
        return;
    }
    let _ = app.notification().builder().title("Your agent setup changed").body(parts.join(" · ")).show();
    run_in_page(app, "document.getElementById('updated')&&(document.getElementById('updated').hidden=false)");
}

fn show_startup_error(app: &AppHandle, message: &str) {
    let text = serde_json::to_string(message).unwrap_or_else(|_| "\"The engine stopped.\"".into());
    run_in_page(app, &format!("(()=>{{const e=document.getElementById('error');if(e){{e.hidden=false;e.textContent={text};}}}})()"));
}

fn start_engine(app: &AppHandle) -> tauri::Result<()> {
    let template = app.path().resolve("template.html", BaseDirectory::Resource)?;
    let (mut events, child) = app
        .shell()
        .sidecar(ENGINE_SIDECAR)
        .map_err(|e| tauri::Error::Anyhow(e.into()))?
        .args(["serve", "--port", "0"])
        .env("KLOSTI_TEMPLATE", template.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    *app.state::<Engine>().0.lock().expect("engine lock") = Some(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim().to_string();
                    if let Some(rest) = line.split(READY_MARKER).nth(1) {
                        let address = rest.split_whitespace().next().unwrap_or_default();
                        if let (Ok(url), Some(window)) = (Url::parse(address), handle.get_webview_window(MAIN_WINDOW)) {
                            let _ = window.navigate(url);
                        }
                    } else {
                        notify_change(&handle, &line);
                    }
                }
                CommandEvent::Stderr(bytes) => eprintln!("engine: {}", String::from_utf8_lossy(&bytes).trim()),
                CommandEvent::Terminated(status) => {
                    show_startup_error(&handle, &format!("The engine stopped (exit code {:?}). Quit and reopen the app.", status.code));
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Klosti", true, None::<&str>)?;
    let scan = MenuItem::with_id(app, "scan", "Scan now", true, None::<&str>)?;
    let at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, "login", "Open at login", true, at_login, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Klosti", true, None::<&str>)?;
    let first_separator = PredefinedMenuItem::separator(app)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &scan, &first_separator, &login, &second_separator, &quit])?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("klosti")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Klosti")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "scan" => {
                show_main(app);
                run_in_page(app, "document.getElementById('rescan')?.click()");
            }
            "login" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let _ = if enabled { manager.disable() } else { manager.enable() };
                let _ = login.set_checked(!enabled);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Engine(Mutex::new(None)))
        .setup(|app| {
            build_tray(app.handle())?;
            start_engine(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the app running in the menu bar, so watching continues.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Klosti");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        RunEvent::Exit => {
            if let Some(child) = app.state::<Engine>().0.lock().expect("engine lock").take() {
                let _ = child.kill();
            }
        }
        _ => {}
    });
}
