// ChatStream Labs - cangkang Tauri (pengganti src/main.js Electron).
// Server + konektor tetap kode lama (src/server.js) yang jalan sebagai proses pendamping (node + sidecar.js).
// Berkas ini mengurus: splash, Dashboard, jendela chat (pin/klik-tembus), tray, hotkey global, sembunyikan dari tangkapan layar.
// Protokol dengan sidecar: lihat src/sidecar.js (JSON per baris lewat stdin/stdout).
//
// Belum ada di tahap ini (lihat shell/README.md): Browser Dock, jendela tombol (ctl) & alert hadiah, area klik di dalam jendela
// ter-pin, simpan CSS, fallback Kick (netFetch), auto-update.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU16, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// ---------------------------------------------------------------- state
struct DockSt {
    id: String,
    locked: bool,
    url: String,
    cont: (f64, f64), // ukuran isi halaman hasil pengukuran (mode "Ukuran otomatis"); (0,0) = belum terukur
}

struct Shell {
    geo_busy: AtomicBool, // sedang menggeser / mengubah ukuran jendela (satu pada satu waktu)
    chat_geom: Mutex<(i32, i32, u32, u32, f64)>, // posisi/ukuran jendela chat (px fisik) + skala, untuk hover_loop
    rects: Mutex<Vec<(f64, f64, f64, f64)>>,     // kotak yang boleh diklik di jendela ter-pin (dari hook shape)
    ga_ok: AtomicBool,                           // halaman alert sudah dimuat
    ga_q: Mutex<Vec<Value>>,                     // alert yang menunggu halaman dimuat
    ga_side: Mutex<String>,                      // sisi/posisi alert terakhir yang dikirim ke halaman
    ga_gen: AtomicU64,                           // nomor alert terakhir (untuk membatalkan timer sembunyi/lepas)
    upd_busy: AtomicBool,
    ctrl_pos: Mutex<String>,               // posisi kotak tombol chat: top-right, bottom-left, dst.
    docks: Mutex<HashMap<String, DockSt>>, // Browser Dock yang sedang terbuka (kunci = label jendela)
    dock_prot: Mutex<HashMap<String, bool>>, // v1.1.9: "mata" tiap Browser Dock (kunci = san(id)); tidak ada = tersembunyi dari OBS (bawaan)
    child: Mutex<Option<CommandChild>>,
    port: AtomicU16,
    app_ready: AtomicBool, // false selama splash (tidak ada jendela aplikasi yang boleh tampil)
    locked: AtomicBool,    // chat dock di-PIN (klik tembus)
    protect: AtomicBool,   // sembunyikan dari tangkapan layar / OBS
    quitting: AtomicBool,
    asking: AtomicBool,
    dash_loaded: AtomicBool,
    dash_suspended: AtomicBool,
    bounds_dirty: AtomicBool,
    restarts: AtomicU16,
}

impl Shell {
    fn new() -> Self {
        Shell {
            geo_busy: AtomicBool::new(false),
            chat_geom: Mutex::new((0, 0, 0, 0, 1.0)),
            rects: Mutex::new(Vec::new()),
            ga_ok: AtomicBool::new(false),
            ga_q: Mutex::new(Vec::new()),
            ga_side: Mutex::new(String::new()),
            ga_gen: AtomicU64::new(0),
            upd_busy: AtomicBool::new(false),
            ctrl_pos: Mutex::new("top-right".to_string()),
            docks: Mutex::new(HashMap::new()),
            dock_prot: Mutex::new(HashMap::new()),
            child: Mutex::new(None),
            port: AtomicU16::new(0),
            app_ready: AtomicBool::new(false),
            locked: AtomicBool::new(false),
            protect: AtomicBool::new(true),
            quitting: AtomicBool::new(false),
            asking: AtomicBool::new(false),
            dash_loaded: AtomicBool::new(false),
            dash_suspended: AtomicBool::new(false),
            bounds_dirty: AtomicBool::new(false),
            restarts: AtomicU16::new(0),
        }
    }
}

fn sh(app: &AppHandle) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}

// ---------------------------------------------------------------- util
// Folder data SAMA dengan versi Electron (%APPDATA%\ChatStream Labs): pengaturan lama otomatis terbawa.
fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .data_dir()
        .map(|d| d.join("ChatStream Labs"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn log(app: &AppHandle, msg: &str) {
    use std::io::Write;
    let p = data_dir(app).join("shell-log.txt");
    if let Ok(m) = std::fs::metadata(&p) {
        if m.len() > 1_000_000 {
            let _ = std::fs::remove_file(&p);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "{} {}", t, msg);
    }
}

fn read_global(app: &AppHandle) -> Value {
    let p = data_dir(app).join("settings.json");
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("global").cloned())
        .unwrap_or_else(|| json!({}))
}

fn page_url(app: &AppHandle, path: &str) -> tauri::Url {
    let mut port = sh(app).port.load(Ordering::SeqCst);
    if port == 0 {
        port = 3000;
    }
    format!("http://localhost:{}{}", port, path).parse().expect("url tidak sah")
}

fn send(app: &AppHandle, v: Value) {
    if let Ok(mut g) = sh(app).child.lock() {
        if let Some(c) = g.as_mut() {
            let _ = c.write(format!("{}\n", v).as_bytes());
        }
    }
}

fn push_state(app: &AppHandle, open: Option<bool>) {
    let open = open.unwrap_or_else(|| app.get_webview_window("chat").is_some());
    let locked = sh(app).locked.load(Ordering::SeqCst);
    let docks: serde_json::Map<String, Value> = {
        let s = sh(app);
        let m = s.docks.lock().unwrap_or_else(|e| e.into_inner());
        m.values()
            .map(|d| (d.id.clone(), json!({"open": true, "locked": d.locked})))
            .collect()
    };
    send(
        app,
        json!({"t":"state","dash":{"chat":{"open":open,"locked":locked},"docks":Value::Object(docks)}}),
    );
}

// v1.1.9: "mata" (sembunyikan dari OBS) kini per jendela, bukan satu saklar untuk semua:
//   - Chat Dock + jendela alert hadiah + kotak tombol chat -> sh.protect
//   - tiap Browser Dock + kotak tombolnya -> dock_prot (bawaan tersembunyi)
//   - Dashboard dan jendela yang dibuka dari Dashboard (win-*) -> SELALU terlihat di OBS
fn dock_prot(app: &AppHandle, id: &str) -> bool {
    sh(app).dock_prot.lock().ok().and_then(|m| m.get(&san(id)).copied()).unwrap_or(true)
}

fn load_dock_prot(app: &AppHandle, v: Option<&Value>) {
    if let Ok(mut m) = sh(app).dock_prot.lock() {
        m.clear();
        if let Some(o) = v.and_then(|x| x.as_object()) {
            for (k, val) in o {
                m.insert(san(k), val.as_bool() != Some(false));
            }
        }
    }
}

fn prot_for(app: &AppHandle, label: &str) -> bool {
    if label == "chat" || label == "galert" || label == "ctl-chat" {
        return sh(app).protect.load(Ordering::SeqCst);
    }
    if let Some(id) = label.strip_prefix("dock-") {
        return dock_prot(app, id);
    }
    if let Some(id) = label.strip_prefix("ctl-") {
        return dock_prot(app, id);
    }
    false
}

fn apply_protect(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        let on = prot_for(app, &label);
        let _ = w.set_content_protected(on);
        if label.starts_with("ctl-") {
            let _ = w.eval(&format!("window.__st&&window.__st({{prot:{}}})", on));
        }
    }
}

// ---------------------------------------------------------------- hemat RAM: argumen WebView2 + pembuat jendela
// SEMUA jendela harus memakai argumen yang SAMA (kalau berbeda, WebView2 gagal berbagi satu lingkungan: error 0x8007139F), jadi semua
// jendela dibuat lewat wb(). Bawaan Tauri (msWebOOUI, msPdfOOUI, msSmartScreenProtection) tetap disertakan karena argumen buatan sendiri MENGGANTI bawaan.
// Cadangan tanpa build ulang: buat berkas  %APPDATA%\ChatStream Labs\webview-args.txt  berisi argumen sendiri; isi "default" = hanya bawaan Tauri
// (kalau ada yang rusak/patah-patah); hapus berkasnya = pakai set hemat di bawah. Perubahan berlaku setelah aplikasi dibuka ulang.
const WV_DEFAULT: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
const WV_LEAN: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,site-per-process,IsolateOrigins --in-process-gpu --renderer-process-limit=2 --enable-low-end-device-mode --disable-background-networking --disable-component-update --no-pings";
static WV_ARGS: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn wv_args(app: &AppHandle) -> &'static str {
    WV_ARGS
        .get_or_init(|| {
            let custom = std::fs::read_to_string(data_dir(app).join("webview-args.txt")).unwrap_or_default();
            let c = custom.trim();
            let (src, args) = if c.is_empty() {
                ("hemat (bawaan aplikasi)", WV_LEAN.to_string())
            } else if c.eq_ignore_ascii_case("default") {
                ("webview-args.txt = default", WV_DEFAULT.to_string())
            } else {
                ("webview-args.txt (buatan sendiri)", c.replace(['\r', '\n'], " "))
            };
            log(app, &format!("webview: argumen {}: {}", src, args));
            args
        })
        .as_str()
}

fn wb<'a>(app: &'a AppHandle, label: &str, url: WebviewUrl) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, label.to_string(), url).additional_browser_args(wv_args(app))
}

// ---------------------------------------------------------------- posisi jendela
fn bounds_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("shell-state.json")
}

fn load_bounds(app: &AppHandle, key: &str) -> Option<(i32, i32, u32, u32)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(bounds_path(app)).ok()?).ok()?;
    let b = v.get(key)?;
    Some((
        b.get("x")?.as_i64()? as i32,
        b.get("y")?.as_i64()? as i32,
        b.get("w")?.as_u64()? as u32,
        b.get("h")?.as_u64()? as u32,
    ))
}

fn save_bounds(app: &AppHandle) {
    let mut v: Value = std::fs::read_to_string(bounds_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if !v.is_object() {
        v = json!({});
    }
    let mut keys: Vec<String> = vec!["chat".to_string(), "dash".to_string()];
    for (l, _) in app.webview_windows() {
        if l.starts_with("dock-") {
            keys.push(l);
        }
    }
    for key in keys.iter() {
        // Browser Dock yang di-pin tidak menyimpan posisi (sama seperti versi lama)
        let pinned = sh(app)
            .docks
            .lock()
            .map(|m| m.get(key.as_str()).map(|d| d.locked).unwrap_or(false))
            .unwrap_or(false);
        if pinned {
            continue;
        }
        if let Some(w) = app.get_webview_window(key) {
            if w.is_minimized().unwrap_or(false) || w.is_maximized().unwrap_or(false) {
                continue;
            }
            if let (Ok(p), Ok(s)) = (w.outer_position(), w.inner_size()) {
                v[key.as_str()] = json!({"x": p.x, "y": p.y, "w": s.width, "h": s.height});
            }
        }
    }
    let _ = std::fs::write(bounds_path(app), v.to_string());
}

fn on_screen(app: &AppHandle, x: i32, y: i32) -> bool {
    app.available_monitors()
        .map(|ms| {
            ms.iter().any(|m| {
                let p = m.position();
                let s = m.size();
                x >= p.x - 50 && y >= p.y - 50 && x < p.x + s.width as i32 && y < p.y + s.height as i32
            })
        })
        .unwrap_or(true)
}

fn restore_bounds(app: &AppHandle, w: &WebviewWindow, key: &str) {
    if let Some((x, y, wd, ht)) = load_bounds(app, key) {
        if on_screen(app, x, y) && wd >= 200 && ht >= 150 {
            let _ = w.set_position(PhysicalPosition::new(x, y));
            let _ = w.set_size(PhysicalSize::new(wd, ht));
        }
    }
}

// ---------------------------------------------------------------- Dashboard
fn make_dash(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let w = wb(app, "dash", WebviewUrl::External(page_url(app, "/?view=dashboard")))
        .title("ChatStream Labs - Dashboard")
        .inner_size(1100.0, 700.0)
        .min_inner_size(860.0, 540.0)
        .decorations(false)
        .visible(false)
        .center()
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                webview.app_handle().state::<Shell>().dash_loaded.store(true, Ordering::SeqCst);
            }
        })
        .build()?;
    restore_bounds(app, &w, "dash");
    let _ = w.set_content_protected(false); // v1.1.9: Dashboard selalu terlihat di OBS
    let a = app.clone();
    w.on_window_event(move |ev| match ev {
        WindowEvent::CloseRequested { api, .. } => {
            if !a.state::<Shell>().quitting.load(Ordering::SeqCst) {
                api.prevent_close();
                let b = a.clone();
                std::thread::spawn(move || ask_quit(&b));
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            a.state::<Shell>().bounds_dirty.store(true, Ordering::SeqCst);
        }
        _ => {}
    });
    Ok(w)
}

fn show_dash(app: &AppHandle) {
    if !sh(app).app_ready.load(Ordering::SeqCst) {
        return;
    }
    if app.get_webview_window("dash").is_none() {
        // Dashboard sudah dihancurkan untuk hemat RAM (lihat schedule_suspend): buat lagi, tunggu halamannya selesai dimuat agar tidak berkedip kosong
        sh(app).dash_loaded.store(false, Ordering::SeqCst);
        if let Err(e) = make_dash(app) {
            log(app, &format!("gagal membuat ulang Dashboard: {}", e));
            return;
        }
        let t0 = Instant::now();
        while !sh(app).dash_loaded.load(Ordering::SeqCst) && t0.elapsed() < Duration::from_secs(8) {
            std::thread::sleep(Duration::from_millis(80));
        }
    }
    sh(app).dash_suspended.store(false, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("dash") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Hemat RAM: Dashboard yang disembunyikan ke tray > 3 dtk DIHANCURKAN (bukan sekadar dikosongkan), dibuat lagi saat dibuka.
// Kalau tidak ada jendela web lain yang terbuka, semua proses WebView2 ikut berhenti: RAM diam turun ke Rust + node saja.
fn schedule_suspend(app: &AppHandle) {
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        if let Some(w) = a.get_webview_window("dash") {
            let s = a.state::<Shell>();
            if !w.is_visible().unwrap_or(true) && !s.quitting.load(Ordering::SeqCst) {
                s.dash_suspended.store(true, Ordering::SeqCst);
                save_bounds(&a); // simpan posisi/ukuran sebelum dihancurkan
                let _ = w.destroy();
            }
        }
    });
}

fn open_report(app: &AppHandle) {
    let was_suspended = sh(app).dash_suspended.load(Ordering::SeqCst);
    show_dash(app);
    if was_suspended {
        std::thread::sleep(Duration::from_millis(2500));
    }
    if let Some(w) = app.get_webview_window("dash") {
        let _ = w.eval("window.__goTab&&window.__goTab('r')");
    }
}

// ---------------------------------------------------------------- jendela chat (dock)
fn open_chat(app: &AppHandle) {
    let s = sh(app);
    if !s.app_ready.load(Ordering::SeqCst) {
        return;
    }
    if let Some(w) = app.get_webview_window("chat") {
        let _ = w.unminimize();
        if !w.is_visible().unwrap_or(false) {
            let _ = w.show();
        }
        if !s.locked.load(Ordering::SeqCst) {
            let _ = w.set_focus();
        }
        return;
    }
    s.locked.store(true, Ordering::SeqCst); // dibuka dalam keadaan di-pin; lepas pin lewat tray / hotkey
    make_chat(app);
}

fn make_chat(app: &AppHandle) {
    let locked = sh(app).locked.load(Ordering::SeqCst);
    let path = format!("/?view=dock&locked=1{}", if locked { "&pin=1" } else { "" });
    let built = wb(app, "chat", WebviewUrl::External(page_url(app, &path)))
        .title("ChatStream Labs")
        .inner_size(460.0, 800.0)
        .min_inner_size(300.0, 300.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false) // ukuran diubah lewat hook resize / grip_loop (bukan bawaan Windows)
        .focused(false)
        .visible(false)
        .build();
    match built {
        Ok(w) => {
            restore_bounds(app, &w, "chat");
            let _ = w.set_content_protected(prot_for(app, "chat"));
            if locked {
                let _ = w.set_ignore_cursor_events(true);
            }
            set_noactivate(&w, locked);
            let a = app.clone();
            w.on_window_event(move |ev| match ev {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    a.state::<Shell>().bounds_dirty.store(true, Ordering::SeqCst);
                    update_geom(&a);
                    pos_ctl(&a, "chat");
                    pos_galert(&a);
                }
                WindowEvent::Destroyed => {
                    a.state::<Shell>().locked.store(false, Ordering::SeqCst);
                    let b = a.clone();
                    std::thread::spawn(move || {
                        if let Some(c) = b.get_webview_window("ctl-chat") {
                            let _ = c.destroy();
                        }
                        if let Some(g) = b.get_webview_window("galert") {
                            let _ = g.destroy();
                        }
                        push_state(&b, Some(false));
                    });
                }
                _ => {}
            });
            let _ = w.show();
            update_geom(app);
            make_ctl(app, "chat");
            push_state(app, Some(true));
        }
        Err(e) => log(app, &format!("gagal membuat jendela chat: {}", e)),
    }
}

// Pin = klik tembus (tidak bisa diklik/difokus). Lepas pin = jendela menerima klik, bisa digeser dan di-resize.
fn set_lock(app: &AppHandle, on: bool) {
    let s = sh(app);
    if !s.app_ready.load(Ordering::SeqCst) {
        return;
    }
    let Some(w) = app.get_webview_window("chat") else {
        if on {
            open_chat(app);
        }
        return;
    };
    if s.locked.swap(on, Ordering::SeqCst) == on {
        return;
    }
    let _ = w.unminimize();
    if on {
        let _ = w.set_ignore_cursor_events(true);
        set_noactivate(&w, true);
        let _ = w.eval("window.__pin&&window.__pin(true)");
    } else {
        let _ = w.set_ignore_cursor_events(false);
        set_noactivate(&w, false);
        let _ = w.set_focus();
        let _ = w.eval("window.__pin&&window.__pin(false)");
    }
    js(app, "ctl-chat", &format!("window.__st&&window.__st({{lk:{}}})", on));
    save_bounds(app);
    push_state(app, None);
}

fn toggle_lock(app: &AppHandle) {
    let on = !sh(app).locked.load(Ordering::SeqCst);
    set_lock(app, on);
}

#[repr(C)]
struct Pt {
    x: i32,
    y: i32,
}

#[repr(C)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(p: *mut Pt) -> i32;
    fn GetWindowRect(hwnd: isize, r: *mut Rect) -> i32;
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetAsyncKeyState(vk: i32) -> i16;
    fn GetSystemMetrics(idx: i32) -> i32;
    fn WindowFromPoint(p: Pt) -> isize;
    fn GetAncestor(hwnd: isize, flags: u32) -> isize;
    fn GetWindowLongPtrW(hwnd: isize, idx: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, idx: i32, val: isize) -> isize;
}

const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;

const GWL_EXSTYLE: i32 = -20;
const GWLP_HWNDPARENT: i32 = -8; // pemilik jendela (owner): jendela milik selalu tampil di atas pemiliknya
const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
const WS_EX_NOACTIVATE: isize = 0x0800_0000;

fn hwnd_of(w: &WebviewWindow) -> Option<isize> {
    w.hwnd().ok().map(|h| h.0 as isize)
}

// Jendela yang tidak boleh merebut fokus keyboard (pin, kotak tombol).
fn set_noactivate(w: &WebviewWindow, on: bool) {
    if let Some(h) = hwnd_of(w) {
        unsafe {
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            let n = if on { ex | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW } else { ex & !WS_EX_NOACTIVATE };
            if n != ex {
                SetWindowLongPtrW(h, GWL_EXSTYLE, n);
            }
        }
    }
}

fn set_owner(child: &WebviewWindow, parent: &WebviewWindow) {
    if let (Some(c), Some(p)) = (hwnd_of(child), hwnd_of(parent)) {
        unsafe {
            SetWindowLongPtrW(c, GWLP_HWNDPARENT, p);
        }
    }
}

// ---------------------------------------------------------------- geser & ubah ukuran buatan sendiri
// Kenapa tidak memakai geser/resize bawaan Windows: geser bawaan memicu "snap" (jendela menempel ke tepi atas = layar penuh), dan area sudut
// resize bawaan Tauri hanya ±5 px. Di sini jendela diikutkan ke kursor lewat SetWindowPos selama tombol kiri mouse ditekan (seperti versi Electron).
// Dipakai chat dan Browser Dock. Hanya satu geser/resize berjalan pada satu waktu (geo_busy).
fn lbutton_down() -> bool {
    unsafe {
        let vk = if GetSystemMetrics(23) != 0 { 0x02 } else { 0x01 }; // SM_SWAPBUTTON: tombol mouse ditukar (kidal)
        (GetAsyncKeyState(vk) as u16 & 0x8000) != 0
    }
}

fn start_move(app: &AppHandle, label: &str) {
    let s = sh(app);
    if s.geo_busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(h) = app.get_webview_window(label).and_then(|w| hwnd_of(&w)) else {
        s.geo_busy.store(false, Ordering::SeqCst);
        return;
    };
    let a = app.clone();
    let lbl = label.to_string();
    std::thread::spawn(move || {
        let mut c0 = Pt { x: 0, y: 0 };
        let mut r0 = Rect { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe {
            GetCursorPos(&mut c0);
            GetWindowRect(h, &mut r0);
        }
        if lbl == "chat" {
            js(&a, "chat", "window.__pause&&window.__pause(true)"); // halaman chat berhenti menggambar selama digeser
        }
        let t0 = Instant::now();
        while lbutton_down() && t0.elapsed() < Duration::from_secs(25) && !a.state::<Shell>().quitting.load(Ordering::SeqCst) {
            let mut c = Pt { x: 0, y: 0 };
            unsafe {
                GetCursorPos(&mut c);
                SetWindowPos(h, 0, r0.left + c.x - c0.x, r0.top + c.y - c0.y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            }
            std::thread::sleep(Duration::from_millis(12));
        }
        if lbl == "chat" {
            js(&a, "chat", "window.__pause&&window.__pause(false)");
        }
        let st = a.state::<Shell>();
        st.bounds_dirty.store(true, Ordering::SeqCst);
        st.geo_busy.store(false, Ordering::SeqCst);
    });
}

// edge: gabungan huruf n/s/e/w, mis. "e", "se", "nw". Sisi yang berlawanan tetap diam. min_w/min_h dalam piksel CSS.
fn start_resize_poll(app: &AppHandle, label: &str, edge: &str, min_w: f64, min_h: f64) {
    let (n, s_, e, w_) = (edge.contains('n'), edge.contains('s'), edge.contains('e'), edge.contains('w'));
    if !(n || s_ || e || w_) {
        return;
    }
    let st = sh(app);
    if st.geo_busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(win) = app.get_webview_window(label) else {
        st.geo_busy.store(false, Ordering::SeqCst);
        return;
    };
    let Some(h) = hwnd_of(&win) else {
        st.geo_busy.store(false, Ordering::SeqCst);
        return;
    };
    let sf = win.scale_factor().unwrap_or(1.0);
    let (minw, minh) = ((min_w * sf).round() as i32, (min_h * sf).round() as i32);
    let a = app.clone();
    std::thread::spawn(move || {
        let mut c0 = Pt { x: 0, y: 0 };
        let mut r0 = Rect { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe {
            GetCursorPos(&mut c0);
            GetWindowRect(h, &mut r0);
        }
        let t0 = Instant::now();
        while lbutton_down() && t0.elapsed() < Duration::from_secs(25) && !a.state::<Shell>().quitting.load(Ordering::SeqCst) {
            let mut c = Pt { x: 0, y: 0 };
            unsafe {
                GetCursorPos(&mut c);
            }
            let (dx, dy) = (c.x - c0.x, c.y - c0.y);
            let mut l = r0.left;
            let mut t = r0.top;
            let mut r = r0.right;
            let mut b = r0.bottom;
            if w_ {
                l = (r0.left + dx).min(r0.right - minw);
            }
            if e {
                r = (r0.right + dx).max(r0.left + minw);
            }
            if n {
                t = (r0.top + dy).min(r0.bottom - minh);
            }
            if s_ {
                b = (r0.bottom + dy).max(r0.top + minh);
            }
            unsafe {
                SetWindowPos(h, 0, l, t, r - l, b - t, SWP_NOZORDER | SWP_NOACTIVATE);
            }
            std::thread::sleep(Duration::from_millis(12));
        }
        let st = a.state::<Shell>();
        st.bounds_dirty.store(true, Ordering::SeqCst);
        st.geo_busy.store(false, Ordering::SeqCst);
    });
}

fn min_size_of(label: &str) -> (f64, f64) {
    if label == "chat" { (300.0, 300.0) } else { (160.0, 100.0) }
}

// Browser Dock (halaman luar, tidak bisa memasang pegangan sendiri) dan chat: tekan tombol kiri di PINGGIR atau terutama di SUDUT jendela
// yang tidak di-pin = ubah ukuran. Sudut 18 px (dua arah sekaligus), tepi 8 px. Hanya jendela yang benar-benar ada di bawah kursor
// (bukan tertutup jendela lain, mis. kotak tombol) yang dihitung.
fn grip_loop(app: AppHandle) {
    let mut was_down = false;
    loop {
        std::thread::sleep(Duration::from_millis(25));
        if sh(&app).quitting.load(Ordering::SeqCst) {
            break;
        }
        let down = lbutton_down();
        let pressed = down && !was_down;
        was_down = down;
        if !pressed || sh(&app).geo_busy.load(Ordering::SeqCst) {
            continue;
        }
        let mut labels: Vec<String> = sh(&app)
            .docks
            .lock()
            .map(|m| m.iter().filter(|(_, d)| !d.locked).map(|(l, _)| l.clone()).collect())
            .unwrap_or_default();
        if !sh(&app).locked.load(Ordering::SeqCst) && app.get_webview_window("chat").is_some() {
            labels.push("chat".to_string());
        }
        let mut c = Pt { x: 0, y: 0 };
        unsafe {
            GetCursorPos(&mut c);
        }
        for label in labels {
            let Some(w) = app.get_webview_window(&label) else { continue };
            if !w.is_visible().unwrap_or(false) {
                continue;
            }
            let Some(h) = hwnd_of(&w) else { continue };
            let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
            unsafe {
                GetWindowRect(h, &mut r);
            }
            if c.x < r.left || c.x >= r.right || c.y < r.top || c.y >= r.bottom {
                continue;
            }
            let root = unsafe { GetAncestor(WindowFromPoint(Pt { x: c.x, y: c.y }), 2) }; // 2 = GA_ROOT
            if root != h {
                continue;
            }
            let sf = w.scale_factor().unwrap_or(1.0);
            let (e_px, c_px) = ((8.0 * sf) as i32, (18.0 * sf) as i32);
            let (x, y) = (c.x - r.left, c.y - r.top);
            let (ww, hh) = (r.right - r.left, r.bottom - r.top);
            let (cl, cr, ct, cb) = (x < c_px, x >= ww - c_px, y < c_px, y >= hh - c_px);
            let mut edge = String::new();
            if (cl || cr) && (ct || cb) {
                edge.push(if ct { 'n' } else { 's' });
                edge.push(if cl { 'w' } else { 'e' });
            } else if x < e_px {
                edge.push('w');
            } else if x >= ww - e_px {
                edge.push('e');
            } else if y < e_px {
                edge.push('n');
            } else if y >= hh - e_px {
                edge.push('s');
            }
            if !edge.is_empty() {
                let (mw, mh) = min_size_of(&label);
                start_resize_poll(&app, &label, &edge, mw, mh);
                break;
            }
        }
    }
}

// ---------------------------------------------------------------- kotak tombol (mata, pin, pindah, tutup)
// Jendela kecil tanpa bingkai di LUAR jendela chat (di DALAM pojok kanan atas untuk Browser Dock), memuat /?view=ctl&t=<chat|id dock>.
// Tidak merebut fokus, jadi di atas game tetap bisa diklik. Dimiliki jendela induknya (selalu di atasnya), ikut bergerak/sembunyi/tutup.
const CW: i32 = 162;
const CH: i32 = 36;
const CM: i32 = 4;

fn san(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

fn parent_label(t: &str) -> String {
    if t == "chat" { "chat".to_string() } else { format!("dock-{}", san(t)) }
}

fn ctl_label(t: &str) -> String {
    format!("ctl-{}", san(t))
}

fn urlenc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{:02X}", b));
        }
    }
    o
}

fn js(app: &AppHandle, label: &str, code: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.eval(code);
    }
}

fn lock_of(app: &AppHandle, t: &str) -> bool {
    if t == "chat" {
        sh(app).locked.load(Ordering::SeqCst)
    } else {
        sh(app)
            .docks
            .lock()
            .ok()
            .and_then(|m| m.get(&parent_label(t)).map(|d| d.locked))
            .unwrap_or(false)
    }
}

fn pos_ctl(app: &AppHandle, t: &str) {
    let (Some(p), Some(c)) = (app.get_webview_window(&parent_label(t)), app.get_webview_window(&ctl_label(t))) else {
        return;
    };
    let (Ok(pp), Ok(ps)) = (p.outer_position(), p.outer_size()) else { return };
    let sf = p.scale_factor().unwrap_or(1.0);
    let cw = (CW as f64 * sf).round() as i32;
    let ch = (CH as f64 * sf).round() as i32;
    let cm = (CM as f64 * sf).round() as i32;
    let pw = ps.width as i32;
    let ph = ps.height as i32;
    let (mut x, mut y) = if t == "chat" {
        let pos = sh(app).ctrl_pos.lock().map(|s| s.clone()).unwrap_or_else(|_| "top-right".to_string());
        let top = pos.starts_with("top");
        let x = if pos.ends_with("left") {
            pp.x
        } else if pos.ends_with("right") {
            pp.x + pw - cw
        } else {
            pp.x + (pw - cw) / 2
        };
        (x, if top { pp.y - ch - cm } else { pp.y + ph + cm })
    } else {
        ((pp.x + pw - cw - cm).max(pp.x), pp.y + cm)
    };
    if let Ok(Some(m)) = p.current_monitor() {
        let mp = m.position();
        let ms = m.size();
        x = x.max(mp.x).min(mp.x + ms.width as i32 - cw);
        y = y.max(mp.y).min(mp.y + ms.height as i32 - ch);
    }
    let _ = c.set_position(PhysicalPosition::new(x, y));
    let _ = c.set_size(PhysicalSize::new(cw as u32, ch as u32));
}

fn sync_ctl_vis(app: &AppHandle, t: &str) {
    let (Some(p), Some(c)) = (app.get_webview_window(&parent_label(t)), app.get_webview_window(&ctl_label(t))) else {
        return;
    };
    if p.is_visible().unwrap_or(false) && !p.is_minimized().unwrap_or(false) {
        pos_ctl(app, t);
        let _ = c.show();
    } else {
        let _ = c.hide();
        if t == "chat" {
            ga_hide(app);
        }
    }
}

fn make_ctl(app: &AppHandle, t: &str) {
    let label = ctl_label(t);
    if app.get_webview_window(&label).is_some() {
        return;
    }
    let Some(parent) = app.get_webview_window(&parent_label(t)) else { return };
    let prot = prot_for(app, &label);
    let lk = lock_of(app, t);
    let path = format!("/?view=ctl&t={}&prot={}&lk={}", urlenc(t), if prot { 1 } else { 0 }, if lk { 1 } else { 0 });
    let built = wb(app, &label, WebviewUrl::External(page_url(app, &path)))
        .title("ChatStream Labs - kontrol")
        .inner_size(CW as f64, CH as f64)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build();
    match built {
        Ok(c) => {
            set_noactivate(&c, true);
            set_owner(&c, &parent);
            let _ = c.set_content_protected(prot);
            pos_ctl(app, t);
            sync_ctl_vis(app, t);
        }
        Err(e) => log(app, &format!("gagal membuat kotak tombol {}: {}", label, e)),
    }
}

// ---------------------------------------------------------------- Browser Dock (widget donasi: alert / media share)
// Satu jendela per dock (transparan, tanpa bingkai, selalu di atas) memuat URL widget. Pengaturan (daftar dock) dibaca dari settings.json
// (global.donateDocks). Pin = klik tembus + tidak bisa difokus + isi tidak bisa diklik; lepas pin = bisa digeser (tombol pindah) dan di-resize (tepi).
// Isi widget diskalakan otomatis supaya muat di jendela (zoom = min(lebar/refW, tinggi/refH)).
// Belum ada: tombol Bisu, "Ukuran otomatis" (mengukur isi halaman), coba-muat-ulang otomatis kalau halaman gagal.
fn don_cfg(app: &AppHandle) -> Vec<Value> {
    read_global(app).get("donateDocks").and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

fn don_find(app: &AppHandle, id: &str) -> Option<Value> {
    don_cfg(app).into_iter().find(|d| d.get("id").and_then(|v| v.as_str()) == Some(id))
}

fn don_url(cfg: &Value) -> Result<tauri::Url, String> {
    let raw = cfg.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if raw.is_empty() {
        return Err("Isi URL dulu, lalu klik Simpan.".to_string());
    }
    match raw.parse::<tauri::Url>() {
        Ok(u) if u.scheme() == "http" || u.scheme() == "https" => Ok(u),
        _ => Err("URL tidak valid. Awali dengan http:// atau https://.".to_string()),
    }
}

fn num(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
}

fn state_get(app: &AppHandle) -> Value {
    let v: Value = std::fs::read_to_string(bounds_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if v.is_object() { v } else { json!({}) }
}

fn don_locked_saved(app: &AppHandle, id: &str) -> bool {
    state_get(app)
        .get("donLocked")
        .and_then(|m| m.get(id))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn don_save_lock(app: &AppHandle, id: &str, on: bool) {
    let mut v = state_get(app);
    if !v["donLocked"].is_object() {
        v["donLocked"] = json!({});
    }
    v["donLocked"][id] = json!(on);
    let _ = std::fs::write(bounds_path(app), v.to_string());
}

fn dock_mode(w: &WebviewWindow, locked: bool) {
    let _ = w.set_ignore_cursor_events(locked);
    set_noactivate(w, locked);
}

fn dock_is_locked(app: &AppHandle, label: &str) -> bool {
    sh(app)
        .docks
        .lock()
        .ok()
        .and_then(|m| m.get(label).map(|d| d.locked))
        .unwrap_or(false)
}

// Skala isi widget supaya muat di jendela.
fn dock_fit(app: &AppHandle, id: &str) {
    let label = parent_label(id);
    let (Some(w), Some(cfg)) = (app.get_webview_window(&label), don_find(app, id)) else { return };
    let sf = w.scale_factor().unwrap_or(1.0);
    let Ok(sz) = w.inner_size() else { return };
    let cw = sz.width as f64 / sf;
    let ch = sz.height as f64 / sf;
    let mut rw = num(cfg.get("refW")).filter(|v| *v >= 1.0).unwrap_or(1280.0);
    let mut rh = num(cfg.get("refH")).filter(|v| *v >= 1.0).unwrap_or(720.0);
    // "Ukuran otomatis": pakai ukuran isi halaman hasil pengukuran (kalau sudah terukur), supaya isi widget memenuhi jendela
    if cfg.get("auto").and_then(|v| v.as_bool()) == Some(true) {
        let cont = sh(app)
            .docks
            .lock()
            .ok()
            .and_then(|m| m.get(&label).map(|d| d.cont))
            .unwrap_or((0.0, 0.0));
        if cont.0 >= 20.0 && cont.1 >= 20.0 {
            rw = cont.0;
            rh = cont.1;
        }
    }
    let z = if cfg.get("fit").and_then(|v| v.as_bool()) == Some(false) {
        1.0
    } else {
        (cw / rw).min(ch / rh).max(0.1).min(10.0)
    };
    let _ = w.set_zoom(z);
}

// CSS yang disuntik ke halaman widget: latar transparan, opacity isi, isi tidak bisa diklik saat di-pin, bingkai tipis saat tidak di-pin.
fn dock_css_js(cfg: &Value, locked: bool) -> String {
    let op = num(cfg.get("opacity")).map(|v| v.round()).filter(|v| *v > 0.0).unwrap_or(100.0).max(10.0).min(100.0);
    let dock_op = num(cfg.get("dockOp")).map(|v| v.round()).unwrap_or(100.0).max(0.0).min(100.0);
    let mut css = String::from("html,body{background:transparent!important}*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}");
    if locked {
        css.push_str("*{pointer-events:none!important}");
    }
    if op < 100.0 {
        css.push_str(&format!("html{{opacity:{}!important}}", op / 100.0));
    }
    if !locked && dock_op > 0.0 {
        css.push_str(&format!("html{{background:rgba(14,18,20,{})!important}}", dock_op / 100.0));
    }
    let tpl = "(function(){var s=document.getElementById('__cs_css');if(!s){s=document.createElement('style');s.id='__cs_css';(document.head||document.documentElement).appendChild(s);}s.textContent=__CSS__;var f=document.getElementById('__cs_fr');if(__FRAME__){if(!f){f=document.createElement('div');f.id='__cs_fr';f.style.cssText='position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;box-sizing:border-box;z-index:2147483647;box-shadow:inset 0 0 0 2px rgba(255,255,255,.4)';var q=[['left:0;top:0;border-left:3px solid #fff;border-top:3px solid #fff'],['right:0;top:0;border-right:3px solid #fff;border-top:3px solid #fff'],['left:0;bottom:0;border-left:3px solid #fff;border-bottom:3px solid #fff'],['right:0;bottom:0;border-right:3px solid #fff;border-bottom:3px solid #fff']];for(var i=0;i<4;i++){var k=document.createElement('i');k.style.cssText='position:absolute;width:16px;height:16px;box-sizing:border-box;'+q[i][0];f.appendChild(k);}var g=['left:0;top:0;width:18px;height:18px;cursor:nwse-resize','right:0;top:0;width:18px;height:18px;cursor:nesw-resize','left:0;bottom:0;width:18px;height:18px;cursor:nesw-resize','right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize','left:0;top:18px;bottom:18px;width:8px;cursor:ew-resize','right:0;top:18px;bottom:18px;width:8px;cursor:ew-resize','left:18px;right:18px;top:0;height:8px;cursor:ns-resize','left:18px;right:18px;bottom:0;height:8px;cursor:ns-resize'];for(var j=0;j<8;j++){var z=document.createElement('b');z.style.cssText='position:absolute;pointer-events:auto;'+g[j].replace(/cursor:([a-z-]+)/,'cursor:$1!important');f.appendChild(z);}(document.body||document.documentElement).appendChild(f);}}else if(f){f.remove();}})()";
    tpl.replace("__CSS__", &serde_json::to_string(&css).unwrap_or_else(|_| "\"\"".to_string()))
        .replace("__FRAME__", if locked { "false" } else { "true" })
}

// Skrip yang berjalan DI DALAM halaman widget (hanya saat "Ukuran otomatis" nyala): tiap 1 dtk mengukur kotak isi yang terlihat
// (gambar, video, kanvas, svg, iframe, teks) lalu menulis hasilnya ke bagian # alamat halaman lewat history.replaceState (tidak memuat ulang,
// tidak memicu hashchange). Cangkang membacanya dari url() jendela. Halaman yang memakai # sendiri dibiarkan (tidak diukur).
const MEAS_JS: &str = r##"(function(){if(window.__cslm)return;window.__cslm=1;var meas=function(){try{var x1=1e9,y1=1e9,x2=-1e9,y2=-1e9,seen=new Map();
function ok(e){var v=seen.get(e);if(v===undefined){var s=getComputedStyle(e);v=s.display!=='none'&&+s.opacity!==0;seen.set(e,v);}return v;}
function vis(el){if(getComputedStyle(el).visibility==='hidden')return false;for(var e=el;e&&e.nodeType===1;e=e.parentElement)if(!ok(e))return false;return true;}
function add(r){if(r.width<2||r.height<2)return;x1=Math.min(x1,r.left);y1=Math.min(y1,r.top);x2=Math.max(x2,r.right);y2=Math.max(y2,r.bottom);}
var n=0,els=document.querySelectorAll('img,video,canvas,svg,iframe');for(var i=0;i<els.length;i++){if(++n>600)break;if(vis(els[i]))add(els[i].getBoundingClientRect());}
var tw=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT),rg=document.createRange();
for(var t,k=0;(t=tw.nextNode())&&k<1500;k++){if(!t.nodeValue.trim())continue;var p=t.parentElement;if(!p||/^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)||!vis(p))continue;rg.selectNodeContents(t);add(rg.getBoundingClientRect());}
if(x2<x1)return null;return{w:x2-x1,h:y2-y1};}catch(e){return null;}};
function tick(){var m=meas();if(!m)return;var h=location.hash;if(h&&h.indexOf('#__csl=')!==0)return;try{history.replaceState(history.state,'',location.pathname+location.search+'#__csl='+Math.ceil(m.w)+','+Math.ceil(m.h));}catch(e){}}
setInterval(tick,1000);setTimeout(tick,300);})()"##;

// Membaca hasil ukur dari alamat halaman tiap 1 dtk. Ukuran yang dipakai = yang TERBESAR yang pernah terlihat (naik saja, tidak turun
// saat widget kosong), jadi tidak bolak-balik mengecil-membesar. URL ini bisa memuat kunci stream, jadi TIDAK PERNAH dicatat ke log.
fn dock_measure_loop(app: AppHandle, id: String) {
    let label = parent_label(&id);
    loop {
        std::thread::sleep(Duration::from_millis(1000));
        let Some(w) = app.get_webview_window(&label) else { break };
        if sh(&app).quitting.load(Ordering::SeqCst) {
            break;
        }
        let auto = don_find(&app, &id)
            .and_then(|c| c.get("auto").and_then(|v| v.as_bool()))
            .unwrap_or(false);
        if !auto {
            continue;
        }
        let Ok(u) = w.url() else { continue };
        let dims = u.fragment().and_then(|f| f.strip_prefix("__csl=")).and_then(|f| {
            let mut it = f.split(',');
            let a = it.next()?.parse::<f64>().ok()?;
            let b = it.next()?.parse::<f64>().ok()?;
            Some((a, b))
        });
        let Some((mw, mh)) = dims else { continue };
        if !(mw >= 20.0 && mh >= 20.0) {
            continue;
        }
        let (mw, mh) = (mw.ceil().min(7680.0), mh.ceil().min(4320.0));
        let grew = {
            let s = sh(&app);
            let mut m = s.docks.lock().unwrap_or_else(|e| e.into_inner());
            match m.get_mut(&label) {
                Some(d) => {
                    let p = d.cont;
                    if mw > p.0 * 1.02 || mh > p.1 * 1.02 {
                        d.cont = (p.0.max(mw), p.1.max(mh));
                        true
                    } else {
                        false
                    }
                }
                None => false,
            }
        };
        if grew {
            dock_fit(&app, &id);
        }
    }
}

// Tombol Bisu (cfg.mute): dijalankan DI DALAM halaman widget. WebView2 versi Tauri 2.12 tidak punya SetIsMuted yang stabil,
// jadi suaranya dibisukan dari dalam halaman: elemen <video>/<audio> (properti muted + play) dan Web Audio (semua keluaran lewat satu GainNode).
// Disuntik saat dokumen mulai dimuat (initialization_script) dan diperbarui lewat window.__cslSetMute(true/false). Berlaku untuk halaman utama
// widget; suara di dalam iframe lintas-situs tidak terjangkau (batasan, dicatat di HANDOFF).
const MUTE_JS: &str = r##"(function(m){window.__cslMute=m;if(window.__cslSetMute){window.__cslSetMute(m);return;}
var gains=[],P=window.HTMLMediaElement&&HTMLMediaElement.prototype;
function sweep(){try{var l=document.querySelectorAll('video,audio');for(var i=0;i<l.length;i++){l[i].muted=!!window.__cslMute;}}catch(e){}}
if(P){var d=Object.getOwnPropertyDescriptor(P,'muted');
if(d&&d.set){Object.defineProperty(P,'muted',{get:function(){return d.get.call(this);},set:function(v){d.set.call(this,window.__cslMute?true:v);},configurable:true});
var pl=P.play;P.play=function(){if(window.__cslMute)d.set.call(this,true);return pl.apply(this,arguments);};}}
try{var oc=AudioNode.prototype.connect;AudioNode.prototype.connect=function(t){
if(window.AudioDestinationNode&&t instanceof AudioDestinationNode&&this.context){var c=this.context;
if(!c.__cslg){c.__cslg=c.createGain();oc.call(c.__cslg,t);gains.push(c.__cslg);}
c.__cslg.gain.value=window.__cslMute?0:1;
var a=[].slice.call(arguments);a[0]=c.__cslg;return oc.apply(this,a);}
return oc.apply(this,arguments);};}catch(e){}
window.__cslSetMute=function(v){window.__cslMute=!!v;sweep();for(var i=0;i<gains.length;i++){try{gains[i].gain.value=v?0:1;}catch(e){}}};
try{new MutationObserver(sweep).observe(document,{childList:true,subtree:true});}catch(e){}
document.addEventListener('DOMContentLoaded',sweep);sweep();})(__M__)"##;

fn mute_js(cfg: &Value) -> String {
    let on = cfg.get("mute").and_then(|v| v.as_bool()).unwrap_or(false);
    MUTE_JS.replace("__M__", if on { "true" } else { "false" })
}

fn dock_apply(app: &AppHandle, id: &str) {
    let label = parent_label(id);
    let locked = dock_is_locked(app, &label);
    let Some(cfg) = don_find(app, id) else { return };
    dock_fit(app, id);
    js(app, &label, &dock_css_js(&cfg, locked));
    js(app, &label, &mute_js(&cfg));
    if cfg.get("auto").and_then(|v| v.as_bool()) == Some(true) {
        js(app, &label, MEAS_JS);
    }
}

fn make_dock(app: &AppHandle, id: &str, locked: bool) -> Result<(), String> {
    let cfg = don_find(app, id).ok_or_else(|| "Browser Dock tidak ditemukan.".to_string())?;
    let url = don_url(&cfg)?;
    let label = parent_label(id);
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    let title = cfg.get("name").and_then(|v| v.as_str()).unwrap_or("Browser Dock").to_string();
    let idc = id.to_string();
    let w = wb(app, &label, WebviewUrl::External(url.clone()))
        .title(title)
        .inner_size(420.0, 520.0)
        .min_inner_size(160.0, 100.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false) // ukuran diubah lewat grip_loop (sudut 18 px), bukan bawaan Windows (sudut ±5 px)
        .focused(false)
        .visible(false)
        .initialization_script(mute_js(&cfg))
        .on_page_load(move |wv, p| {
            if matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                let a = wv.app_handle().clone();
                let i = idc.clone();
                std::thread::spawn(move || dock_apply(&a, &i));
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    if let Ok(mut m) = sh(app).docks.lock() {
        m.insert(label.clone(), DockSt { id: id.to_string(), locked, url: url.to_string(), cont: (0.0, 0.0) });
    }
    restore_bounds(app, &w, &label);
    let _ = w.set_content_protected(prot_for(app, &label));
    dock_mode(&w, locked);
    let a = app.clone();
    let i2 = id.to_string();
    w.on_window_event(move |ev| match ev {
        WindowEvent::Moved(_) => {
            a.state::<Shell>().bounds_dirty.store(true, Ordering::SeqCst);
            pos_ctl(&a, &i2);
        }
        WindowEvent::Resized(_) => {
            a.state::<Shell>().bounds_dirty.store(true, Ordering::SeqCst);
            pos_ctl(&a, &i2);
            dock_fit(&a, &i2);
        }
        WindowEvent::Destroyed => {
            let b = a.clone();
            let i3 = i2.clone();
            std::thread::spawn(move || {
                if let Ok(mut m) = b.state::<Shell>().docks.lock() {
                    m.remove(&parent_label(&i3));
                }
                if let Some(c) = b.get_webview_window(&ctl_label(&i3)) {
                    let _ = c.destroy();
                }
                push_state(&b, None);
            });
        }
        _ => {}
    });
    let _ = w.show();
    make_ctl(app, id);
    push_state(app, None);
    let (ma, mi) = (app.clone(), id.to_string());
    std::thread::spawn(move || dock_measure_loop(ma, mi));
    Ok(())
}

// Pin / lepas pin satu dock pada jendela YANG SAMA (halaman widget tidak dimuat ulang, jadi media share tidak terputus).
fn dock_set_lock(app: &AppHandle, id: &str, on: bool) {
    don_save_lock(app, id, on);
    let label = parent_label(id);
    let Some(w) = app.get_webview_window(&label) else { return };
    let changed = {
        let s = sh(app);
        let mut m = s.docks.lock().unwrap_or_else(|e| e.into_inner());
        match m.get_mut(&label) {
            Some(d) if d.locked != on => {
                d.locked = on;
                true
            }
            _ => false,
        }
    };
    if !changed {
        return;
    }
    let _ = w.unminimize();
    dock_mode(&w, on);
    dock_apply(app, id);
    js(app, &ctl_label(id), &format!("window.__st&&window.__st({{lk:{}}})", on));
    save_bounds(app);
    push_state(app, None);
}

// Dipanggil tiap pengaturan berubah: dock yang dihapus / URL-nya kosong ditutup; nama, ukuran acuan, opacity, URL diterapkan.
fn don_sync(app: &AppHandle) {
    let items: Vec<(String, String, String)> = {
        let s = sh(app);
        let m = s.docks.lock().unwrap_or_else(|e| e.into_inner());
        m.iter().map(|(l, d)| (l.clone(), d.id.clone(), d.url.clone())).collect()
    };
    for (label, id, loaded) in items {
        let Some(w) = app.get_webview_window(&label) else { continue };
        let cfg = don_find(app, &id);
        let url = cfg.as_ref().and_then(|c| don_url(c).ok());
        match (cfg, url) {
            (Some(cfg), Some(u)) => {
                if let Some(n) = cfg.get("name").and_then(|v| v.as_str()) {
                    let _ = w.set_title(n);
                }
                if u.to_string() != loaded {
                    if let Ok(mut m) = sh(app).docks.lock() {
                        if let Some(d) = m.get_mut(&label) {
                            d.url = u.to_string();
                            d.cont = (0.0, 0.0); // URL baru = ukur ulang isinya
                        }
                    }
                    let code = format!("location.replace({})", serde_json::to_string(u.as_str()).unwrap_or_default());
                    let _ = w.eval(&code);
                }
                dock_apply(app, &id);
            }
            _ => {
                let _ = w.close();
            }
        }
    }
}

// act: open | close | reload | toggle. id kosong = semua dock
fn donate_act(app: &AppHandle, act: &str, id: &str) -> Value {
    if !sh(app).app_ready.load(Ordering::SeqCst) {
        return json!({"ok": true});
    }
    if act == "toggle" {
        let any = sh(app)
            .docks
            .lock()
            .map(|m| m.keys().any(|l| app.get_webview_window(l).map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false)))
            .unwrap_or(false);
        return donate_act(app, if any { "close" } else { "open" }, id);
    }
    if !["open", "close", "reload"].contains(&act) {
        return json!({"error": "Perintah tidak dikenal."});
    }
    let ids: Vec<String> = if id.is_empty() {
        don_cfg(app)
            .iter()
            .filter_map(|d| d.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect()
    } else {
        vec![id.to_string()]
    };
    if ids.is_empty() {
        return json!({"error": "Belum ada Browser Dock. Tambahkan dulu di menu Browser Dock."});
    }
    let mut err: Option<String> = None;
    for i in ids {
        let label = parent_label(&i);
        let w = app.get_webview_window(&label);
        match act {
            "close" => {
                if let Some(w) = w {
                    let _ = w.close();
                }
            }
            "reload" => {
                if let Some(w) = w {
                    match don_find(app, &i).map(|c| don_url(&c)) {
                        Some(Ok(u)) => {
                            let code = format!("location.replace({})", serde_json::to_string(u.as_str()).unwrap_or_default());
                            let _ = w.eval(&code);
                        }
                        Some(Err(e)) => err = Some(e),
                        None => {}
                    }
                } else if !id.is_empty() {
                    err = Some("Browser Dock belum dibuka.".to_string());
                }
            }
            _ => match don_find(app, &i) {
                None => err = Some("Browser Dock tidak ditemukan.".to_string()),
                Some(cfg) => match don_url(&cfg) {
                    Err(e) => err = Some(e),
                    Ok(_) => {
                        if let Some(w) = w {
                            if !w.is_visible().unwrap_or(false) {
                                let _ = w.show();
                                sync_ctl_vis(app, &i);
                            }
                        } else if let Err(e) = make_dock(app, &i, don_locked_saved(app, &i)) {
                            err = Some(e);
                        }
                    }
                },
            },
        }
    }
    match err {
        Some(e) => json!({"error": e}),
        None => json!({"ok": true}),
    }
}

// ---------------------------------------------------------------- klik di dalam jendela chat ter-pin ("bulatan" chat/filter, kolom ketik)
// Jendela ter-pin tembus klik. Halaman melaporkan kotak-kotak yang boleh diklik lewat hook "shape" (koordinat CSS di dalam jendela).
// Selama kursor ada di atas salah satu kotak, jendela menerima klik; di luar itu tembus lagi. Dicek ±30x per detik.
// ---------------------------------------------------------------- roda mouse global (chat ter-pin bisa di-scroll tanpa menyentuh bilah scroll)
// Jendela chat yang di-pin tembus klik, jadi roda mouse tidak sampai ke halamannya. Seperti versi Electron (hook WH_MOUSE_LL), sebuah hook mouse
// tingkat rendah memantau roda: kalau kursor ada di dalam jendela chat yang ter-pin dan pengaturan "Chat bisa di-scroll saat terkunci" nyala,
// roda DITELAN (aplikasi/game di belakang tidak ikut ter-scroll) dan deltanya dikirim ke halaman chat (#list). Klik tetap tembus seperti biasa.
// Hook dipasang sekali, di thread sendiri dengan message loop; isi callback hanya membaca variabel atomik (cepat, tidak memperlambat mouse).
static WHEEL_ON: AtomicBool = AtomicBool::new(false);
static WHEEL_ACC: AtomicI32 = AtomicI32::new(0);
static WHEEL_L: AtomicI32 = AtomicI32::new(0);
static WHEEL_T: AtomicI32 = AtomicI32::new(0);
static WHEEL_R: AtomicI32 = AtomicI32::new(0);
static WHEEL_B: AtomicI32 = AtomicI32::new(0);
// v1.1.8: "Chat bisa di-scroll saat terkunci" nyala bawaan (mati hanya kalau pengguna sendiri mematikannya: kunci lockScroll bernilai false)
static LOCK_SCROLL: AtomicBool = AtomicBool::new(true);
static WHEEL_HOOK: std::sync::Once = std::sync::Once::new();

#[repr(C)]
struct MsLl {
    x: i32,
    y: i32,
    data: u32,
    flags: u32,
    time: u32,
    extra: usize,
}

extern "system" {
    fn SetWindowsHookExW(id: i32, f: unsafe extern "system" fn(i32, usize, isize) -> isize, hmod: isize, tid: u32) -> isize;
    fn CallNextHookEx(hook: isize, code: i32, w: usize, l: isize) -> isize;
    fn GetMessageW(msg: *mut u64, hwnd: isize, min: u32, max: u32) -> i32;
    fn GetModuleHandleW(name: *const u16) -> isize;
}

unsafe extern "system" fn wheel_hook(code: i32, w: usize, l: isize) -> isize {
    if code >= 0 && w == 0x020A && WHEEL_ON.load(Ordering::Relaxed) {
        // 0x020A = WM_MOUSEWHEEL
        let m = &*(l as *const MsLl);
        if m.x >= WHEEL_L.load(Ordering::Relaxed)
            && m.x < WHEEL_R.load(Ordering::Relaxed)
            && m.y >= WHEEL_T.load(Ordering::Relaxed)
            && m.y < WHEEL_B.load(Ordering::Relaxed)
        {
            WHEEL_ACC.fetch_add((m.data >> 16) as i16 as i32, Ordering::Relaxed);
            return 1; // telan roda: tidak diteruskan ke jendela di belakang
        }
    }
    CallNextHookEx(0, code, w, l)
}

fn wheel_install() {
    WHEEL_HOOK.call_once(|| {
        std::thread::spawn(|| unsafe {
            let hm = GetModuleHandleW(std::ptr::null());
            if SetWindowsHookExW(14, wheel_hook, hm, 0) == 0 {
                return; // 14 = WH_MOUSE_LL; gagal = chat tetap bisa di-scroll lewat bilah scroll cadangan
            }
            let mut msg = [0u64; 8]; // cukup untuk struct MSG (48 byte)
            while GetMessageW(msg.as_mut_ptr(), 0, 0, 0) > 0 {}
        });
    });
}

fn wheel_loop(app: AppHandle) {
    let mut tick: u32 = 0;
    loop {
        std::thread::sleep(Duration::from_millis(16));
        if sh(&app).quitting.load(Ordering::SeqCst) {
            break;
        }
        tick = tick.wrapping_add(1);
        if tick % 8 == 1 {
            let want = sh(&app).locked.load(Ordering::SeqCst)
                && LOCK_SCROLL.load(Ordering::Relaxed)
                && app.get_webview_window("chat").map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false);
            let (gx, gy, gw, gh, _) = sh(&app).chat_geom.lock().map(|g| *g).unwrap_or((0, 0, 0, 0, 1.0));
            if want && gw > 0 && gh > 0 {
                WHEEL_L.store(gx, Ordering::Relaxed);
                WHEEL_T.store(gy, Ordering::Relaxed);
                WHEEL_R.store(gx + gw as i32, Ordering::Relaxed);
                WHEEL_B.store(gy + gh as i32, Ordering::Relaxed);
                wheel_install();
                WHEEL_ON.store(true, Ordering::Relaxed);
            } else if WHEEL_ON.swap(false, Ordering::Relaxed) {
                WHEEL_ACC.store(0, Ordering::Relaxed);
            }
        }
        let d = WHEEL_ACC.swap(0, Ordering::Relaxed);
        if d != 0 && WHEEL_ON.load(Ordering::Relaxed) {
            // roda ke atas (delta positif) = isi bergeser turun = scrollTop berkurang. 120 unit per klik roda ≈ 100 px.
            js(
                &app,
                "chat",
                &format!("(function(){{var l=document.getElementById('list');if(l)l.scrollTop-={};}})()", (d as f64) * 0.85),
            );
        }
    }
}

fn hover_loop(app: AppHandle) {
    let mut last: Option<bool> = None;
    loop {
        let (locked, quitting) = {
            let s = sh(&app);
            (s.locked.load(Ordering::SeqCst), s.quitting.load(Ordering::SeqCst))
        };
        if quitting {
            break;
        }
        std::thread::sleep(Duration::from_millis(if locked { 33 } else { 250 }));
        if !locked {
            last = None;
            continue;
        }
        let Some(w) = app.get_webview_window("chat") else { continue };
        let (gx, gy, gw, gh, sf) = sh(&app).chat_geom.lock().map(|g| *g).unwrap_or((0, 0, 0, 0, 1.0));
        let mut p = Pt { x: 0, y: 0 };
        unsafe {
            GetCursorPos(&mut p);
        }
        let inside = gw > 0 && p.x >= gx && p.y >= gy && p.x < gx + gw as i32 && p.y < gy + gh as i32;
        let want_ignore = if !inside {
            true
        } else {
            let cx = (p.x - gx) as f64 / sf;
            let cy = (p.y - gy) as f64 / sf;
            let hit = sh(&app)
                .rects
                .lock()
                .map(|r| r.iter().any(|q| cx >= q.0 && cx < q.0 + q.2 && cy >= q.1 && cy < q.1 + q.3))
                .unwrap_or(false);
            !hit
        };
        if last != Some(want_ignore) {
            last = Some(want_ignore);
            let _ = w.set_ignore_cursor_events(want_ignore);
        }
    }
}

fn update_geom(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("chat") {
        if let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) {
            let sf = w.scale_factor().unwrap_or(1.0);
            if let Ok(mut g) = sh(app).chat_geom.lock() {
                *g = (p.x, p.y, s.width, s.height, sf);
            }
        }
    }
}

// Kolom ketik di jendela ter-pin: selama terbuka jendela boleh difokus (keyboard ke kolom), begitu ditutup dikembalikan (keyboard ke game).
fn chat_focus(app: &AppHandle, on: bool) {
    let Some(w) = app.get_webview_window("chat") else { return };
    if on {
        set_noactivate(&w, false);
        let _ = w.set_focus();
    } else if sh(app).locked.load(Ordering::SeqCst) {
        set_noactivate(&w, true);
    }
}

// ---------------------------------------------------------------- alert hadiah TikTok (jendela di samping jendela chat)
// Dibuat saat alert pertama datang, disembunyikan sesudah selesai, dilepas (hemat RAM) 45 dtk kemudian. Seluruhnya tembus klik.
const GAW: i32 = 320;
const GAH: i32 = 600;
const GAM: i32 = 6;

fn ga_bounds(app: &AppHandle) -> Option<(i32, i32, &'static str, i32, i32)> {
    let c = app.get_webview_window("chat")?;
    let p = c.outer_position().ok()?;
    let sz = c.outer_size().ok()?;
    let sf = c.scale_factor().unwrap_or(1.0);
    let gaw = (GAW as f64 * sf).round() as i32;
    let gah = (GAH as f64 * sf).round() as i32;
    let gam = (GAM as f64 * sf).round() as i32;
    let (wx, wy, ww, wh) = (p.x, p.y, sz.width as i32, sz.height as i32);
    let (mx, my, mw, mh) = match c.current_monitor() {
        Ok(Some(m)) => (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32),
        _ => (0, 0, 1920, 1080),
    };
    let mut side = "left";
    let mut x = wx - gaw - gam;
    if x < mx {
        side = "right";
        x = wx + ww + gam;
        if x + gaw > mx + mw {
            if wx - mx >= mx + mw - (wx + ww) {
                side = "left";
                x = mx;
            } else {
                x = mx + mw - gaw;
            }
        }
    }
    let y = wy.max(my).min(my + mh - gah);
    let off = (wy - y).max(0);
    let h = wh.min(gah - off).max((60.0 * sf) as i32);
    Some((x, y, side, off, h))
}

fn pos_galert(app: &AppHandle) {
    let Some(g) = app.get_webview_window("galert") else { return };
    let Some((x, y, side, off, h)) = ga_bounds(app) else { return };
    let _ = g.set_position(PhysicalPosition::new(x, y));
    let sf = g.scale_factor().unwrap_or(1.0);
    let key = format!("{}|{}|{}", side, off, h);
    let changed = {
        let s = sh(app);
        let mut k = s.ga_side.lock().unwrap_or_else(|e| e.into_inner());
        if *k != key {
            *k = key;
            true
        } else {
            false
        }
    };
    if changed && sh(app).ga_ok.load(Ordering::SeqCst) {
        js(
            app,
            "galert",
            &format!("window.__gaside&&window.__gaside(\"{}\",{},{})", side, (off as f64 / sf).round(), (h as f64 / sf).round()),
        );
    }
}

fn ga_make(app: &AppHandle) {
    if app.get_webview_window("galert").is_some() {
        return;
    }
    let Some(chat) = app.get_webview_window("chat") else { return };
    sh(app).ga_ok.store(false, Ordering::SeqCst);
    if let Ok(mut k) = sh(app).ga_side.lock() {
        k.clear();
    }
    let built = wb(app, "galert", WebviewUrl::External(page_url(app, "/?view=galert")))
        .title("ChatStream Labs - alert")
        .inner_size(GAW as f64, GAH as f64)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .on_page_load(|wv, p| {
            if matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                let a = wv.app_handle().clone();
                std::thread::spawn(move || ga_loaded(&a));
            }
        })
        .build();
    match built {
        Ok(g) => {
            set_noactivate(&g, true);
            set_owner(&g, &chat);
            let _ = g.set_ignore_cursor_events(true);
            let _ = g.set_content_protected(prot_for(app, "galert"));
            pos_galert(app);
        }
        Err(e) => log(app, &format!("gagal membuat jendela alert: {}", e)),
    }
}

fn ga_loaded(app: &AppHandle) {
    sh(app).ga_ok.store(true, Ordering::SeqCst);
    if let Ok(mut k) = sh(app).ga_side.lock() {
        k.clear();
    }
    pos_galert(app);
    let q: Vec<Value> = sh(app).ga_q.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
    for m in q {
        ga_show(app, &m);
    }
}

fn ga_hide(app: &AppHandle) {
    sh(app).ga_gen.fetch_add(1, Ordering::SeqCst);
    if let Some(g) = app.get_webview_window("galert") {
        let _ = g.hide();
    }
}

fn ga_show(app: &AppHandle, m: &Value) {
    let Some(g) = app.get_webview_window("galert") else { return };
    pos_galert(app);
    let _ = g.show();
    js(app, "galert", &format!("window.__ga&&window.__ga({})", m));
    let gen = sh(app).ga_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let dur = num(m.get("dur")).filter(|d| *d > 0.0).unwrap_or(6.0);
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis((dur * 1000.0) as u64 + 1500));
        if a.state::<Shell>().ga_gen.load(Ordering::SeqCst) != gen {
            return; // ada alert yang lebih baru
        }
        if let Some(g) = a.get_webview_window("galert") {
            let _ = g.hide();
        }
        std::thread::sleep(Duration::from_secs(45));
        if a.state::<Shell>().ga_gen.load(Ordering::SeqCst) == gen {
            if let Some(g) = a.get_webview_window("galert") {
                let _ = g.destroy();
            }
        }
    });
}

// Dipanggil server tiap ada hadiah TikTok yang lolos pengaturan dock; hanya tampil kalau jendela chat sedang terlihat.
fn galert_push(app: &AppHandle, m: &Value) {
    let Some(c) = app.get_webview_window("chat") else { return };
    if !c.is_visible().unwrap_or(false) || c.is_minimized().unwrap_or(false) {
        return;
    }
    if app.get_webview_window("galert").is_none() {
        ga_make(app);
    }
    if !sh(app).ga_ok.load(Ordering::SeqCst) {
        if let Ok(mut q) = sh(app).ga_q.lock() {
            q.push(m.clone());
            if q.len() > 5 {
                q.remove(0);
            }
        }
        return;
    }
    ga_show(app, m);
}

// ---------------------------------------------------------------- simpan CSS (dialog Simpan sebagai)
fn save_css(app: &AppHandle, name: &str, css: &str) -> Value {
    let (tx, rx) = std::sync::mpsc::channel();
    let fname = format!("{}.css", name);
    app.dialog()
        .file()
        .set_title("Ekspor gaya (.css)")
        .set_file_name(&fname)
        .add_filter("CSS", &["css"])
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    match rx.recv_timeout(Duration::from_secs(600)) {
        Ok(Some(fp)) => match fp.into_path() {
            Ok(path) => match std::fs::write(&path, css) {
                Ok(_) => json!({"ok": true, "path": path.to_string_lossy()}),
                Err(e) => json!({"error": e.to_string()}),
            },
            Err(e) => json!({"error": e.to_string()}),
        },
        _ => json!({"canceled": true}),
    }
}

// ---------------------------------------------------------------- pembaruan otomatis (GitHub Releases, repo harus PUBLIC)
// Memeriksa/mengunduh lewat src/updater.js (node terpisah, SHA-256 wajib cocok), lalu menjalankan installer baru dan keluar.
// Nama repo diambil saat build dari GITHUB_REPOSITORY (otomatis di GitHub Actions); kosong = pembaruan nonaktif.
const REPO: &str = match option_env!("GITHUB_REPOSITORY") {
    Some(r) => r,
    None => "",
};

fn node_run(app: &AppHandle, args: Vec<String>, mut on: impl FnMut(&Value)) -> Option<Value> {
    let (mut rx, _child) = app.shell().sidecar("node").ok()?.args(args).spawn().ok()?;
    let mut last: Option<Value> = None;
    tauri::async_runtime::block_on(async {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(b) => {
                    let line = String::from_utf8_lossy(&b).trim().to_string();
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        on(&v);
                        last = Some(v);
                    }
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
    });
    last
}

fn skipped_version(app: &AppHandle) -> Option<String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(bounds_path(app)).ok()?).ok()?;
    v.get("skipUpdate").and_then(|x| x.as_str()).map(|x| x.to_string()).filter(|x| !x.is_empty())
}

fn save_skipped_version(app: &AppHandle, ver: &str) {
    let mut v: Value = std::fs::read_to_string(bounds_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if !v.is_object() {
        v = json!({});
    }
    v["skipUpdate"] = json!(ver);
    let _ = std::fs::write(bounds_path(app), v.to_string());
    log(app, &format!("update: Abaikan (versi {})", ver));
}

fn update_flow(app: &AppHandle, manual: bool, on_pct: &dyn Fn(i64)) -> String {
    if REPO.is_empty() {
        return if manual { "dev".to_string() } else { "none".to_string() };
    }
    if sh(app).upd_busy.swap(true, Ordering::SeqCst) {
        return if manual { "busy".to_string() } else { "none".to_string() };
    }
    let r = update_flow_inner(app, manual, on_pct);
    sh(app).upd_busy.store(false, Ordering::SeqCst);
    r
}

fn update_flow_inner(app: &AppHandle, manual: bool, on_pct: &dyn Fn(i64)) -> String {
    let fail = |msg: &str| -> String {
        log(app, &format!("update: {}", msg));
        if manual {
            app.dialog().message(format!("Pembaruan gagal: {}", msg)).title("Update").blocking_show();
            "error".to_string()
        } else {
            "none".to_string()
        }
    };
    let res = match app.path().resource_dir() {
        Ok(r) => dunce::simplified(&r).to_path_buf(),
        Err(e) => return fail(&e.to_string()),
    };
    let script = res.join("app").join("updater.js").to_string_lossy().to_string();
    let ver = env!("CARGO_PKG_VERSION");
    let Some(c) = node_run(app, vec![script.clone(), "check".into(), REPO.into(), ver.into()], |_| {}) else {
        return fail("pemeriksa tidak berjalan");
    };
    match c.get("status").and_then(|s| s.as_str()) {
        Some("available") => {}
        Some("none") => return "none".to_string(),
        _ => return fail(c.get("error").and_then(|e| e.as_str()).unwrap_or("tidak bisa memeriksa")),
    }
    let nv = c.get("version").and_then(|v| v.as_str()).unwrap_or("?").to_string();
    if !manual && skipped_version(app).as_deref() == Some(nv.as_str()) {
        log(app, &format!("update: versi {} diabaikan pengguna, dilewati", nv));
        return "none".to_string();
    }
    let yes = app
        .dialog()
        .message(format!("Versi baru v{} tersedia.\n\nKamu memakai v{}.", nv, ver))
        .title("Update")
        .buttons(MessageDialogButtons::OkCancelCustom("Update Now".into(), "Later".into()))
        .blocking_show();
    if !yes {
        // Pertanyaan kedua (dialog Tauri hanya punya 2 tombol): abaikan versi ini selamanya, atau tanya lagi saat aplikasi dibuka berikutnya.
        let ignore = app
            .dialog()
            .message(format!("Abaikan v{}?\n\n\"Abaikan\" = tidak ditanya lagi untuk versi ini (tombol Cek Update tetap menanyakannya).", nv))
            .title("Update")
            .buttons(MessageDialogButtons::OkCancelCustom("Abaikan".into(), "Ingatkan nanti".into()))
            .blocking_show();
        if ignore {
            save_skipped_version(app, &nv);
            return "ignored".to_string();
        }
        return "later".to_string();
    }
    let dest = std::env::temp_dir().join("ChatStreamLabs-update-setup.exe");
    on_pct(0);
    let r = node_run(
        app,
        vec![script, "download".into(), REPO.into(), dest.to_string_lossy().to_string()],
        |v| {
            if let Some(p) = v.get("p").and_then(|p| p.as_i64()) {
                on_pct(p);
            }
        },
    );
    match r {
        Some(v) if v.get("status").and_then(|s| s.as_str()) == Some("done") => {}
        Some(v) => return fail(v.get("error").and_then(|e| e.as_str()).unwrap_or("unduhan gagal")),
        None => return fail("pengunduh tidak berjalan"),
    }
    // v1.1.6: pemasangan DIAM-DIAM. Versi sebelumnya memakai "/P /R /UPDATE" (dari ingatan) dan hasilnya wizard installer tetap muncul.
    // Sekarang: cmd menunggu aplikasi ini keluar (ping ±2 dtk), menjalankan installer dengan /S (senyap, semua halaman dilewati; NSIS standar)
    // ke folder pemasangan yang sama (/D=, harus argumen terakhir dan tanpa tanda kutip), MENUNGGU sampai selesai (start /wait), lalu membuka
    // aplikasi lagi. Aplikasi dibuka lagi walau pemasangan gagal (versi lama tetap bisa dipakai). Jendela cmd disembunyikan.
    let started = (|| {
        use std::os::windows::process::CommandExt;
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?.to_path_buf();
        let cmd = format!(
            "/D /C \"ping -n 3 127.0.0.1 >nul & start /wait \"\" \"{}\" /S /UPDATE /D={}& start \"\" \"{}\"\"",
            dest.display(),
            dir.display(),
            exe.display()
        );
        std::process::Command::new("cmd").raw_arg(cmd).creation_flags(0x0800_0000).spawn().ok() // 0x08000000 = CREATE_NO_WINDOW
    })();
    if started.is_none() {
        // cadangan: cara lama (wizard tampil) kalau cmd tidak bisa dijalankan
        if let Err(e) = std::process::Command::new(&dest).args(["/P", "/R", "/UPDATE"]).spawn() {
            return fail(&format!("installer tidak bisa dijalankan: {}", e));
        }
    }
    std::thread::sleep(Duration::from_millis(900));
    quit_app(app);
    "installing".to_string()
}

// ---------------------------------------------------------------- jendela lain (laporan, gaya, pratinjau, ...)
fn open_win(app: &AppHandle, url_s: &str, opt: &Value) {
    let is_prev = url_s.contains("preview=1");
    let key: String = url_s
        .split("view=")
        .nth(1)
        .map(|r| r.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect())
        .filter(|k: &String| !k.is_empty())
        .unwrap_or_else(|| "win".to_string());
    let label = format!("win-{}", key);
    if let Some(old) = app.get_webview_window(&label) {
        let _ = old.destroy();
        std::thread::sleep(Duration::from_millis(250)); // beri waktu label dilepas
    }
    let full: tauri::Url = if url_s.starts_with("http") {
        match url_s.parse() {
            Ok(u) => u,
            Err(_) => return,
        }
    } else {
        page_url(app, url_s)
    };
    let width = opt.get("width").and_then(|v| v.as_f64()).unwrap_or(520.0);
    let height = opt.get("height").and_then(|v| v.as_f64()).unwrap_or(820.0);
    let title = opt.get("title").and_then(|v| v.as_str()).unwrap_or("ChatStream Labs").to_string();
    match wb(app, &label, WebviewUrl::External(full))
        .title(title)
        .inner_size(width, height)
        .decorations(is_prev)
        .center()
        .build()
    {
        Ok(w) => {
            let _ = w.set_content_protected(false); // v1.1.9: jendela yang dibuka dari Dashboard selalu terlihat di OBS
        }
        Err(e) => log(app, &format!("gagal membuka jendela {}: {}", label, e)),
    }
}

fn win_ctl(app: &AppHandle, which: &str, act: &str) {
    let dock_id = which.strip_prefix("donate:");
    let label = match which {
        "main" => "chat".to_string(),
        "dash" => "dash".to_string(),
        o => match dock_id {
            Some(id) => parent_label(id),
            None => format!("win-{}", o),
        },
    };
    let Some(w) = app.get_webview_window(&label) else { return };
    match act {
        "min" => {
            if which == "dash" || which == "main" || dock_id.is_some() {
                let _ = w.hide();
                if which == "dash" {
                    schedule_suspend(app);
                } else if which == "main" {
                    sync_ctl_vis(app, "chat");
                } else if let Some(id) = dock_id {
                    sync_ctl_vis(app, id);
                }
            } else {
                let _ = w.minimize();
            }
        }
        "max" => {
            if dock_id.is_none() {
                if w.is_maximized().unwrap_or(false) {
                    let _ = w.unmaximize();
                } else {
                    let _ = w.maximize();
                }
            }
        }
        "close" => {
            if which == "dash" {
                let a = app.clone();
                std::thread::spawn(move || ask_quit(&a));
            } else {
                let _ = w.close();
            }
        }
        "reload" => {
            let _ = w.eval("location.reload()");
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- keluar / mulai ulang
fn stop_sidecar(app: &AppHandle) {
    let has = sh(app).child.lock().map(|g| g.is_some()).unwrap_or(false);
    if !has {
        return;
    }
    send(app, json!({"t":"quit"})); // sidecar menyimpan data lalu keluar sendiri (biasanya < 100 ms)
    // dulu menunggu tetap 400 ms; sekarang berhenti menunggu begitu sidecar sudah keluar, baru dipaksa kalau lewat 400 ms
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(20));
        let gone = sh(app).child.lock().map(|g| g.is_none()).unwrap_or(true);
        if gone {
            return;
        }
    }
    if let Ok(mut g) = sh(app).child.lock() {
        if let Some(c) = g.take() {
            let _ = c.kill();
        }
    }
}

fn quit_app(app: &AppHandle) {
    sh(app).quitting.store(true, Ordering::SeqCst);
    save_bounds(app);
    // sembunyikan semua jendela dulu supaya terasa langsung tertutup; sisa pekerjaan keluar jalan di belakang
    for (_, w) in app.webview_windows() {
        let _ = w.hide();
    }
    stop_sidecar(app);
    app.exit(0);
}

fn ask_quit(app: &AppHandle) {
    let s = sh(app);
    if s.quitting.load(Ordering::SeqCst) || s.asking.swap(true, Ordering::SeqCst) {
        return;
    }
    let a = app.clone();
    app.dialog()
        .message("Keluar dari ChatStream Labs?")
        .title("Keluar")
        .buttons(MessageDialogButtons::OkCancelCustom("Keluar".into(), "Batal".into()))
        .show(move |yes| {
            a.state::<Shell>().asking.store(false, Ordering::SeqCst);
            if yes {
                quit_app(&a);
            }
        });
}

fn relaunch(app: &AppHandle) -> ! {
    sh(app).quitting.store(true, Ordering::SeqCst);
    save_bounds(app);
    stop_sidecar(app);
    app.restart()
}

// ---------------------------------------------------------------- hotkey global
const HK_DEF: [(&str, &str); 16] = [
    ("lock", "Ctrl+Alt+L"),
    ("hide", "Ctrl+Alt+H"),
    ("obs", "Ctrl+Alt+O"),
    ("up", "Ctrl+Alt+PageUp"),
    ("down", "Ctrl+Alt+PageDown"),
    ("clear", "Ctrl+Alt+C"),
    ("filter", "Ctrl+Alt+F"),
    ("settings", "Ctrl+Alt+S"),
    ("report", "Ctrl+Alt+R"),
    ("donate", "Ctrl+Alt+D"),
    ("chat", ""),
    ("lockscroll", ""),
    ("send", ""),
    ("alertgift", ""),
    ("donatereload", ""),
    ("newsession", ""),
];

fn run_action(app: &AppHandle, name: &str) {
    if !sh(app).app_ready.load(Ordering::SeqCst) {
        return;
    }
    match name {
        "lock" => toggle_lock(app),
        "hide" => {
            if let Some(w) = app.get_webview_window("chat") {
                if w.is_visible().unwrap_or(false) {
                    let _ = w.hide();
                } else {
                    let _ = w.show();
                }
            }
            sync_ctl_vis(app, "chat");
        }
        "donate" => {
            donate_act(app, "toggle", "");
        }
        "donatereload" => {
            donate_act(app, "reload", "");
        }
        "obs" => {
            let p = !sh(app).protect.load(Ordering::SeqCst);
            send(app, json!({"t":"setGlobal","obj":{"protect":p}}));
        }
        "up" | "down" | "clear" | "filter" | "alertgift" => send(app, json!({"t":"cmd","name":name})),
        "settings" => show_dash(app),
        "report" => open_report(app),
        "chat" => open_chat(app),
        "lockscroll" => {
            let cur = read_global(app).get("lockScroll").and_then(|v| v.as_bool()) != Some(false);
            send(app, json!({"t":"setGlobal","obj":{"lockScroll": !cur}}));
        }
        "send" => {
            let cur = read_global(app).get("sendOn").and_then(|v| v.as_bool()) == Some(true);
            send(app, json!({"t":"setGlobal","obj":{"sendOn": !cur}}));
        }
        "newsession" => send(app, json!({"t":"endSession"})),
        _ => {} // donate / donatereload: Browser Dock belum ada di tahap ini
    }
}

fn set_hotkeys(app: &AppHandle, map: &Value) -> Value {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut res = serde_json::Map::new();
    for (name, def) in HK_DEF.iter() {
        let acc = map
            .get(*name)
            .and_then(|v| v.as_str())
            .unwrap_or(def)
            .trim()
            .to_string();
        if acc.is_empty() {
            res.insert(name.to_string(), json!(true));
            continue;
        }
        let n = name.to_string();
        let ok = gs
            .on_shortcut(acc.as_str(), move |app, _sc, ev| {
                if ev.state() == ShortcutState::Pressed {
                    let a = app.clone();
                    let n2 = n.clone();
                    std::thread::spawn(move || run_action(&a, &n2));
                }
            })
            .is_ok();
        res.insert(name.to_string(), json!(ok));
    }
    Value::Object(res)
}

// ---------------------------------------------------------------- hook dari server (sidecar)
fn handle_hook(app: &AppHandle, name: &str, a: &[Value]) -> Value {
    let arg_b = |i: usize| a.get(i).and_then(|v| v.as_bool()).unwrap_or(false);
    let arg_s = |i: usize| a.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match name {
        "protect" => {
            sh(app).protect.store(arg_b(0), Ordering::SeqCst);
            load_dock_prot(app, a.get(1)); // v1.1.9: argumen ke-2 = peta mata Browser Dock {id: true/false}
            apply_protect(app);
            Value::Null
        }
        "open" => {
            let w = arg_s(0);
            if w == "ext" {
                let _ = app
                    .opener()
                    .open_path(data_dir(app).join("extension").to_string_lossy().to_string(), None::<&str>);
            } else if w.starts_with("http://") || w.starts_with("https://") {
                let _ = app.opener().open_url(w, None::<&str>);
            }
            Value::Null
        }
        "window" => {
            open_win(app, &arg_s(0), a.get(1).unwrap_or(&Value::Null));
            Value::Null
        }
        "lock" => {
            let id = arg_s(1);
            if id.is_empty() || id == "chat" {
                set_lock(app, arg_b(0));
            } else {
                dock_set_lock(app, &id, arg_b(0));
            }
            Value::Null
        }
        "drag" => {
            let id = arg_s(1);
            let t = if id.is_empty() { "chat".to_string() } else { id };
            if arg_b(0) && !lock_of(app, &t) {
                start_move(app, &parent_label(&t));
            }
            Value::Null
        }
        "resize" => {
            let id = arg_s(2);
            let t = if id.is_empty() { "chat".to_string() } else { id };
            if arg_b(0) && !lock_of(app, &t) {
                let label = parent_label(&t);
                let (mw, mh) = min_size_of(&label);
                start_resize_poll(app, &label, &arg_s(1), mw, mh);
            }
            Value::Null
        }
        "global" => {
            let pos = a
                .get(0)
                .and_then(|g| g.get("ctrlPos"))
                .and_then(|v| v.as_str())
                .unwrap_or("top-right")
                .to_string();
            if let Ok(mut g) = sh(app).ctrl_pos.lock() {
                *g = pos;
            }
            LOCK_SCROLL.store(
                a.get(0).and_then(|g| g.get("lockScroll")).and_then(|v| v.as_bool()) != Some(false),
                Ordering::Relaxed,
            );
            pos_ctl(app, "chat");
            don_sync(app);
            Value::Null
        }
        "donate" => donate_act(app, &arg_s(0), &arg_s(1)),
        "chatFocus" => {
            chat_focus(app, arg_b(0));
            Value::Null
        }
        "galert" => {
            galert_push(app, a.get(0).unwrap_or(&Value::Null));
            Value::Null
        }
        "saveCss" => save_css(app, &arg_s(0), &arg_s(1)),
        "checkUpdate" => json!(update_flow(app, true, &|_| {})),
        "openSettings" => {
            show_dash(app);
            Value::Null
        }
        "openReport" => {
            open_report(app);
            Value::Null
        }
        "openChat" => {
            open_chat(app);
            Value::Null
        }
        "winCtl" => {
            win_ctl(app, &arg_s(0), &arg_s(1));
            Value::Null
        }
        "relaunch" => relaunch(app),
        "setHotkeys" => set_hotkeys(app, a.get(0).unwrap_or(&Value::Null)),
        // ---- belum tersedia di tahap ini (jawaban jujur supaya UI tidak menggantung)
        "netFetch" => json!({"status": 0, "text": ""}),
        _ => Value::Null, // shape (disimpan di handle_line) dan hook lain yang tidak perlu jawaban
    }
}

fn handle_line(app: &AppHandle, line: &str) {
    if line.is_empty() {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        log(app, &format!("[server?] {}", line));
        return;
    };
    match v.get("t").and_then(|t| t.as_str()) {
        Some("ready") => {
            let p = v.get("port").and_then(|p| p.as_u64()).unwrap_or(3000) as u16;
            sh(app).port.store(p, Ordering::SeqCst);
            send(app, json!({"t":"ver","v":env!("CARGO_PKG_VERSION")}));
            push_state(app, None);
        }
        Some("hook") => {
            let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            // shape sering dipanggil dan murah: disimpan langsung tanpa thread
            if name == "shape" {
                if let Some(arr) = v.get("args").and_then(|a| a.get(0)).and_then(|r| r.as_array()) {
                    let rects: Vec<(f64, f64, f64, f64)> = arr
                        .iter()
                        .filter_map(|q| {
                            Some((
                                q.get("x")?.as_f64()?,
                                q.get("y")?.as_f64()?,
                                q.get("width")?.as_f64()?,
                                q.get("height")?.as_f64()?,
                            ))
                        })
                        .collect();
                    if let Ok(mut g) = sh(app).rects.lock() {
                        *g = rects;
                    }
                }
                return;
            }
            let args = v.get("args").and_then(|a| a.as_array()).cloned().unwrap_or_default();
            let id = v.get("id").and_then(|i| i.as_u64());
            let a = app.clone();
            std::thread::spawn(move || {
                let r = handle_hook(&a, &name, &args);
                if let Some(id) = id {
                    send(&a, json!({"t":"reply","id":id,"value":r}));
                }
            });
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- sidecar (node + sidecar.js)
fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    let res = dunce::simplified(&res).to_path_buf(); // buang awalan \\?\ yang tidak disukai node
    let script = res.join("app").join("sidecar.js");
    let ext = res.join("app").join("extension");
    let (mut rx, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| e.to_string())?
        // hemat RAM node: batas heap 192 MB dan ruang objek muda 1 MB (cukup untuk server ini; naikkan kalau ada "out of memory" di shell-log.txt)
        .args(["--max-old-space-size=192".to_string(), "--max-semi-space-size=1".to_string(), script.to_string_lossy().to_string()])
        .env("CG_DATA", data_dir(app).to_string_lossy().to_string())
        .env("CSL_EXT_SRC", ext.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Ok(mut g) = sh(app).child.lock() {
        *g = Some(child);
    }
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(b) => handle_line(&a, String::from_utf8_lossy(&b).trim()),
                CommandEvent::Stderr(b) => log(&a, &format!("[server] {}", String::from_utf8_lossy(&b).trim_end())),
                CommandEvent::Terminated(p) => {
                    log(&a, &format!("[server] berhenti, kode {:?}", p.code));
                    if let Ok(mut g) = sh(&a).child.lock() {
                        *g = None;
                    }
                    let s = sh(&a);
                    if !s.quitting.load(Ordering::SeqCst) && s.restarts.fetch_add(1, Ordering::SeqCst) < 3 {
                        let b = a.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(1000));
                            if let Err(e) = spawn_sidecar(&b) {
                                log(&b, &format!("[server] gagal dijalankan ulang: {}", e));
                            }
                        });
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

// ---------------------------------------------------------------- start-up (di balik splash)
fn startup(app: AppHandle) {
    let t0 = Instant::now();
    if let Err(e) = spawn_sidecar(&app) {
        log(&app, &format!("[server] gagal dijalankan: {}", e));
        app.dialog()
            .message(format!("Server lokal gagal dijalankan:\n{}", e))
            .title("ChatStream Labs")
            .blocking_show();
        app.exit(1);
        return;
    }
    while sh(&app).port.load(Ordering::SeqCst) == 0 {
        if t0.elapsed() > Duration::from_secs(40) {
            log(&app, "[server] tidak siap dalam 40 detik");
            app.dialog()
                .message("Server lokal tidak siap dalam 40 detik. Lihat shell-log.txt di folder data.")
                .title("ChatStream Labs")
                .blocking_show();
            app.exit(1);
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let splash = app.get_webview_window("splash");
    // cek pembaruan (hanya kalau repo diketahui saat build); kalau ada dan dipasang, aplikasi keluar dan installer mengambil alih
    if !REPO.is_empty() {
        let sp = splash.clone();
        let st = update_flow(&app, false, &|p| {
            if let Some(s) = &sp {
                let _ = s.eval(&format!("window.updProgress&&window.updProgress({})", p));
                if p >= 100 {
                    let _ = s.eval("window.updInstall&&window.updInstall()");
                }
            }
        });
        if st == "installing" {
            return;
        }
    }
    if let Some(s) = &splash {
        let _ = s.eval("window.toConnect&&window.toConnect()");
    }
    if let Err(e) = make_dash(&app) {
        log(&app, &format!("gagal membuat Dashboard: {}", e));
    }
    let hk = read_global(&app).get("hotkeys").cloned().unwrap_or_else(|| json!({}));
    set_hotkeys(&app, &hk);
    // splash tampil minimal 3 dtk, dan menunggu halaman Dashboard selesai dimuat (maks 30 dtk)
    loop {
        let loaded = sh(&app).dash_loaded.load(Ordering::SeqCst);
        if (loaded && t0.elapsed() >= Duration::from_secs(3)) || t0.elapsed() > Duration::from_secs(30) {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if let Some(s) = &splash {
        let _ = s.eval("window.finish&&window.finish()");
    }
    std::thread::sleep(Duration::from_millis(700));
    if let Some(s) = splash {
        let _ = s.destroy();
    }
    sh(&app).app_ready.store(true, Ordering::SeqCst);
    show_dash(&app);
    push_state(&app, None);
    // klik di dalam jendela chat ter-pin (lihat hover_loop)
    let hv = app.clone();
    let wl = app.clone();
    std::thread::spawn(move || wheel_loop(wl));
    std::thread::spawn(move || hover_loop(hv));
    let gp = app.clone();
    std::thread::spawn(move || grip_loop(gp));
    // simpan posisi jendela tiap ada perubahan (maks sekali per 2 dtk)
    loop {
        std::thread::sleep(Duration::from_secs(2));
        if sh(&app).bounds_dirty.swap(false, Ordering::SeqCst) {
            save_bounds(&app);
        }
    }
}

// ---------------------------------------------------------------- tray
fn tray_action(app: &AppHandle, id: &str) {
    match id {
        "dash" | "settings" => show_dash(app),
        "chat" => open_chat(app),
        "pin" => toggle_lock(app),
        "donate" => {
            donate_act(app, "toggle", "");
        }
        "report" => open_report(app),
        "quit" => ask_quit(app),
        _ => {}
    }
}

fn build_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let h = app.handle();
    let menu = MenuBuilder::new(h)
        .text("dash", "Buka Dashboard")
        .text("chat", "Buka Chat")
        .text("pin", "Pin / lepas pin jendela chat")
        .text("donate", "Browser Dock (buka / tutup)")
        .text("report", "Laporan penonton")
        .text("settings", "Pengaturan")
        .separator()
        .text("quit", "Keluar")
        .build()?;
    let mut tb = TrayIconBuilder::new().tooltip("ChatStream Labs").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = h.default_window_icon() {
        tb = tb.icon(icon.clone());
    }
    tb.on_menu_event(|app, event| {
        let id = event.id().as_ref().to_string();
        let a = app.clone();
        std::thread::spawn(move || tray_action(&a, &id));
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            let a = tray.app_handle().clone();
            std::thread::spawn(move || show_dash(&a));
        }
    })
    .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------- main
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let a = app.clone();
            std::thread::spawn(move || show_dash(&a));
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Shell::new())
        .setup(|app| {
            let h = app.handle().clone();
            let _ = std::fs::create_dir_all(data_dir(&h));
            let protect = read_global(&h).get("protect").and_then(|v| v.as_bool()) != Some(false);
            sh(&h).protect.store(protect, Ordering::SeqCst);
            load_dock_prot(&h, read_global(&h).get("dockProtect"));
            LOCK_SCROLL.store(read_global(&h).get("lockScroll").and_then(|v| v.as_bool()) != Some(false), Ordering::Relaxed);
            if let Some(p) = read_global(&h).get("ctrlPos").and_then(|v| v.as_str()) {
                if let Ok(mut g) = sh(&h).ctrl_pos.lock() {
                    *g = p.to_string();
                }
            }
            // splash: halaman splash.html lama (ditanam di exe), tidak bisa ditutup pengguna
            wb(&h, "splash", WebviewUrl::App("splash.html".into()))
                .title("ChatStream Labs")
                .inner_size(640.0, 480.0)
                .decorations(false)
                .resizable(false)
                .minimizable(false)
                .maximizable(false)
                .closable(false)
                .center()
                .build()?;
            build_tray(app)?;
            let h2 = h.clone();
            std::thread::spawn(move || startup(h2));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("gagal membangun aplikasi");
    app.run(|app, event| match event {
        // aplikasi tray: menutup jendela terakhir tidak mengakhiri aplikasi; hanya app.exit() (menu Keluar) yang mengakhiri
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => stop_sidecar(app),
        _ => {}
    });
}
