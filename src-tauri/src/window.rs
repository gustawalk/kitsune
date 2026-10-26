use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::Manager;
#[derive(Serialize, Deserialize)]
struct Geometry {
    width: f64,
    height: f64,
    x: i32,
    y: i32,
    maximized: bool,
}
pub fn save<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let state = window.state::<AppState>();
    let Ok(size) = window.inner_size() else {
        return;
    };
    let position = window
        .outer_position()
        .unwrap_or(tauri::PhysicalPosition::new(0, 0));
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = size.to_logical::<f64>(scale);
    let geometry = Geometry {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized: window.is_maximized().unwrap_or(false),
    };
    let _ = state.storage.put("window", "main", &geometry);
}
pub fn restore(app: &tauri::App) {
    let state = app.state::<AppState>();
    let Ok(values) = state.storage.list::<Geometry>("window") else {
        return;
    };
    let Some(g) = values.first() else { return };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.set_size(tauri::LogicalSize::new(
        g.width.clamp(900.0, 3840.0),
        g.height.clamp(600.0, 2160.0),
    ));
    let visible = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .any(|m| {
            let p = m.position();
            let s = m.size();
            g.x >= p.x && g.y >= p.y && g.x < p.x + s.width as i32 && g.y < p.y + s.height as i32
        });
    if visible {
        let _ = window.set_position(tauri::PhysicalPosition::new(g.x, g.y));
    } else {
        let _ = window.center();
    }
    if g.maximized {
        let _ = window.maximize();
    }
}
