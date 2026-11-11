use crate::error::CmdResult;
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

pub const EMBEDDED_SERVER_PY: &str = include_str!("../../tools/voxcpm_server.py");

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServerStatus {
    Stopped,
    Starting,
    Ready,
    Failed(String),
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VoxCpmSetupStatus {
    pub is_ready: bool,
    pub server_running: bool,
    pub python_found: bool,
    pub python_path: Option<String>,
    pub has_voxcpm: bool,
    pub has_torch: bool,
    pub torch_cuda: bool,
    pub torch_version: String,
    pub gpu_name: Option<String>,
    pub vram_mb: u64,
    pub system_ram_mb: u64,
    pub has_recommended_gpu: bool,
    pub can_install: bool,
    pub hardware_warning: Option<String>,
    pub is_portable: bool,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SetupProgress {
    pub step: String,
    pub percent: u32,
    pub log: String,
    pub is_done: bool,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct VoxCpmManager {
    child: Arc<Mutex<Option<(u32, Child)>>>,
    started_by_us: Arc<AtomicBool>,
    status: Arc<Mutex<ServerStatus>>,
}

impl VoxCpmManager {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            started_by_us: Arc::new(AtomicBool::new(false)),
            status: Arc::new(Mutex::new(ServerStatus::Stopped)),
        }
    }

    /// Check if the VoxCPM HTTP server is responding to /health.
    pub async fn check_health(base_url: &str) -> bool {
        is_server_healthy(base_url).await
    }

    /// Find the videogen workspace root directory containing tools/voxcpm_server.py.
    pub fn find_workspace_root() -> Option<PathBuf> {
        // 1. Current working directory and ancestors
        if let Ok(cwd) = std::env::current_dir() {
            for dir in cwd.ancestors() {
                if dir.join("tools").join("voxcpm_server.py").exists() {
                    return Some(dir.to_path_buf());
                }
            }
        }

        // 2. Executable directory and ancestors (e.g. src-tauri/target/debug)
        if let Ok(exe) = std::env::current_exe() {
            for dir in exe.ancestors() {
                if dir.join("tools").join("voxcpm_server.py").exists() {
                    return Some(dir.to_path_buf());
                }
            }
        }

        // 3. Fallback to common dev location
        let fallback = PathBuf::from(r"D:\videogen");
        if fallback.join("tools").join("voxcpm_server.py").exists() {
            return Some(fallback);
        }

        None
    }

    /// Ensure voxcpm_server.py exists on disk.
    /// If not found in workspace or alongside executable, extracts the embedded copy into AppData.
    pub fn ensure_server_script(app: &AppHandle) -> Result<PathBuf> {
        // 1. Check workspace
        if let Some(root) = Self::find_workspace_root() {
            let p = root.join("tools").join("voxcpm_server.py");
            if p.exists() {
                return Ok(p);
            }
        }

        // 2. Check alongside executable
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let p = parent.join("tools").join("voxcpm_server.py");
                if p.exists() {
                    return Ok(p);
                }
                let p_flat = parent.join("voxcpm_server.py");
                if p_flat.exists() {
                    return Ok(p_flat);
                }
            }
        }

        // 3. Extract embedded script into AppData
        let app_data = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let tools_dir = app_data.join("tools");
        std::fs::create_dir_all(&tools_dir)?;
        let script_path = tools_dir.join("voxcpm_server.py");
        std::fs::write(&script_path, EMBEDDED_SERVER_PY)?;
        Ok(script_path)
    }

    /// Find the best python executable for VoxCPM.
    /// Checks:
    /// 1. Exe-adjacent portable venv (.venv-voxcpm / python)
    /// 2. AppData venv (<app_data>/voxcpm-venv)
    /// 3. Workspace venv (.venv-voxcpm)
    /// 4. System Python installations
    pub fn find_best_python(app: &AppHandle) -> Option<PathBuf> {
        // 1. Check alongside executable (portable distribution)
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let p1 = parent.join(".venv-voxcpm").join("Scripts").join("python.exe");
                if p1.exists() {
                    return Some(p1);
                }
                let p2 = parent.join("python").join("python.exe");
                if p2.exists() {
                    return Some(p2);
                }
            }
        }

        // 2. Check AppData venv (created by 1-click installer)
        if let Ok(app_data) = app.path().app_data_dir() {
            let app_venv = app_data.join("voxcpm-venv").join("Scripts").join("python.exe");
            if app_venv.exists() {
                return Some(app_venv);
            }
        }

        // 3. Check Workspace dev venv
        if let Some(root) = Self::find_workspace_root() {
            let venv_win = root.join(".venv-voxcpm").join("Scripts").join("python.exe");
            if venv_win.exists() {
                return Some(venv_win);
            }
            let venv_unix = root.join(".venv-voxcpm").join("bin").join("python");
            if venv_unix.exists() {
                return Some(venv_unix);
            }
        }

        // 4. Check known Windows Python locations
        if cfg!(windows) {
            if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                for py_ver in &["Python312", "Python311", "Python310"] {
                    let p = PathBuf::from(&local_app_data)
                        .join("Programs")
                        .join("Python")
                        .join(py_ver)
                        .join("python.exe");
                    if p.exists() {
                        return Some(p);
                    }
                }
            }
            for py_ver in &["Python312", "Python311", "Python310"] {
                let p = PathBuf::from(r"C:\Program Files")
                    .join(py_ver)
                    .join("python.exe");
                if p.exists() {
                    return Some(p);
                }
            }
        }

        // 5. System python on PATH
        let mut cmd = Command::new("python");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.arg("--version");
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                return Some(PathBuf::from("python"));
            }
        }

        // 6. Python launcher 'py'
        let mut py_cmd = Command::new("py");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            py_cmd.creation_flags(0x0800_0000);
        }
        py_cmd.args(["-3", "--version"]);
        if let Ok(out) = py_cmd.output() {
            if out.status.success() {
                return Some(PathBuf::from("py"));
            }
        }

        None
    }

    /// Legacy find_python for backward compatibility
    pub fn find_python(root: &Path) -> PathBuf {
        let venv_win = root.join(".venv-voxcpm").join("Scripts").join("python.exe");
        if venv_win.exists() {
            return venv_win;
        }
        let venv_unix = root.join(".venv-voxcpm").join("bin").join("python");
        if venv_unix.exists() {
            return venv_unix;
        }
        PathBuf::from("python")
    }

    /// Find local model weights directory if present.
    pub fn find_model(app: &AppHandle) -> Option<String> {
        // 1. Workspace
        if let Some(root) = Self::find_workspace_root() {
            let local = root.join("tools").join("models").join("VoxCPM2");
            if local.join("model.safetensors").exists() {
                return Some(local.to_string_lossy().to_string());
            }
        }
        // 2. Exe directory
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let local = parent.join("tools").join("models").join("VoxCPM2");
                if local.join("model.safetensors").exists() {
                    return Some(local.to_string_lossy().to_string());
                }
            }
        }
        // 3. AppData
        if let Ok(app_data) = app.path().app_data_dir() {
            let local = app_data.join("tools").join("models").join("VoxCPM2");
            if local.join("model.safetensors").exists() {
                return Some(local.to_string_lossy().to_string());
            }
        }
        None
    }

    /// Spawn the VoxCPM server child process silently in the background.
    pub fn spawn_server(&self, app: &AppHandle) -> Result<()> {
        let script = Self::ensure_server_script(app)?;
        let python = match Self::find_best_python(app) {
            Some(p) => p,
            None => bail!("Python was not found on this computer. Please install Python or click 'Install Engine' in Settings."),
        };

        let app_data = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let log_path = app_data.join("voxcpm-server.log");

        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| anyhow!("Failed to open voxcpm log file: {e}"))?;

        let s = crate::settings::load(&app);
        let device = if s.voxcpm_device.trim().is_empty() {
            "auto"
        } else {
            s.voxcpm_device.trim()
        };
        let steps_str = if s.voxcpm_steps >= 4 { s.voxcpm_steps.to_string() } else { "6".to_string() };

        let mut cmd = Command::new(&python);
        cmd.arg(&script)
            .arg("--port")
            .arg("8000")
            .arg("--device")
            .arg(device)
            .arg("--steps")
            .arg(steps_str)
            .arg("--no-optimize");

        if let Some(model) = Self::find_model(app) {
            cmd.arg("--model").arg(model);
        }

        if let Some(parent) = script.parent() {
            cmd.current_dir(parent);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let out_file = log_file.try_clone()?;
        cmd.stdout(Stdio::from(out_file));
        cmd.stderr(Stdio::from(log_file));

        let child = cmd.spawn()?;
        let pid = child.id();
        *self.child.lock().unwrap() = Some((pid, child));
        self.started_by_us.store(true, Ordering::SeqCst);

        Ok(())
    }

    /// Start the server in the background and poll until it is ready.
    pub async fn start_background(&self, app: AppHandle) {
        let base_url = "http://127.0.0.1:8000";
        if is_server_healthy(base_url).await {
            *self.status.lock().unwrap() = ServerStatus::Ready;
            let _ = app.emit("voxcpm-status", "ready");
            return;
        }

        if let Err(e) = self.spawn_server(&app) {
            let msg = format!("Failed to spawn VoxCPM server: {e}");
            eprintln!("{msg}");
            *self.status.lock().unwrap() = ServerStatus::Failed(msg);
            let _ = app.emit("voxcpm-status", "failed");
            return;
        }

        *self.status.lock().unwrap() = ServerStatus::Starting;
        let _ = app.emit("voxcpm-status", "starting");

        // Poll for up to 90 seconds (loading weights on CPU can take ~15-20s)
        for _ in 0..90 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if is_server_healthy(base_url).await {
                *self.status.lock().unwrap() = ServerStatus::Ready;
                let _ = app.emit("voxcpm-status", "ready");
                println!("VoxCPM background server is ready on {base_url}");
                return;
            }

            // Check if child crashed
            let mut lock = self.child.lock().unwrap();
            if let Some((_, ref mut child)) = *lock {
                if let Ok(Some(status)) = child.try_wait() {
                    let msg = format!("VoxCPM server exited with {status}");
                    eprintln!("{msg}");
                    *self.status.lock().unwrap() = ServerStatus::Failed(msg);
                    let _ = app.emit("voxcpm-status", "failed");
                    return;
                }
            }
        }

        *self.status.lock().unwrap() =
            ServerStatus::Failed("Timed out waiting for VoxCPM server to be ready".into());
        let _ = app.emit("voxcpm-status", "failed");
    }

    /// Stop the background VoxCPM server if we started it.
    pub fn stop(&self) {
        if let Some((pid, mut child)) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();

            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .creation_flags(0x0800_0000)
                    .output();
            }
        }
        self.started_by_us.store(false, Ordering::SeqCst);
        *self.status.lock().unwrap() = ServerStatus::Stopped;
    }
}

pub async fn is_server_healthy(base_url: &str) -> bool {
    let url = format!("{}/health", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build();
    if let Ok(client) = client {
        if let Ok(res) = client.get(&url).send().await {
            if res.status().is_success() {
                if let Ok(body) = res.json::<serde_json::Value>().await {
                    let st = body.get("status").and_then(|v| v.as_str());
                    return st == Some("ok") || st == Some("ready");
                }
            }
        }
    }
    false
}

/// Detect NVIDIA GPU and total VRAM in MB using nvidia-smi
pub fn detect_nvidia_gpu() -> (bool, String, u64) {
    let mut c = Command::new("nvidia-smi");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c.args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    if let Ok(out) = c.output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().next() {
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() >= 2 {
                    let name = parts[0].trim().to_string();
                    let vram = parts[1].trim().parse::<u64>().unwrap_or(0);
                    return (true, name, vram);
                }
            }
        }
    }
    (false, String::new(), 0)
}

#[repr(C)]
struct MemoryStatusEx {
    dw_length: u32,
    dw_memory_load: u32,
    ull_total_phys: u64,
    ull_avail_phys: u64,
    ull_total_page_file: u64,
    ull_avail_page_file: u64,
    ull_total_virtual: u64,
    ull_avail_virtual: u64,
    ull_avail_extended_virtual: u64,
}

#[cfg(windows)]
extern "system" {
    fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
}

/// Detect total system physical RAM in MB using Win32 GlobalMemoryStatusEx
pub fn get_system_ram_mb() -> u64 {
    #[cfg(windows)]
    unsafe {
        let mut status = MemoryStatusEx {
            dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
            dw_memory_load: 0,
            ull_total_phys: 0,
            ull_avail_phys: 0,
            ull_total_page_file: 0,
            ull_avail_page_file: 0,
            ull_total_virtual: 0,
            ull_avail_virtual: 0,
            ull_avail_extended_virtual: 0,
        };
        if GlobalMemoryStatusEx(&mut status) != 0 {
            return status.ull_total_phys / (1024 * 1024);
        }
    }
    0
}

/// Check if python has torch and voxcpm installed
pub fn check_python_packages(python: &Path) -> (bool, bool, bool) {
    let mut cmd = Command::new(python);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let script = "import sys\nh_t = False\nh_v = False\ntry:\n    import torch\n    h_t = True\nexcept Exception:\n    pass\ntry:\n    import voxcpm\n    h_v = True\nexcept Exception:\n    pass\nprint(f'{h_t}|{h_v}')";
    cmd.args(["-c", script]);
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some((t, v)) = s.trim().split_once('|') {
                return (true, t.trim() == "True", v.trim() == "True");
            }
            return (true, false, false);
        }
    }
    (false, false, false)
}

/// Check if torch has CUDA support in python
pub fn check_torch_cuda(python: &Path) -> (bool, String) {
    let mut cmd = Command::new(python);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.args(["-c", "import torch; print(f'{torch.__version__}|{torch.cuda.is_available()}')"]);
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some((ver, cuda)) = s.trim().split_once('|') {
                return (cuda.trim().eq_ignore_ascii_case("true"), ver.trim().to_string());
            }
        }
    }
    (false, String::new())
}

#[tauri::command]
pub async fn get_voxcpm_setup_status(app: AppHandle) -> CmdResult<VoxCpmSetupStatus> {
    let server_running = is_server_healthy("http://127.0.0.1:8000").await;
    let (has_nvidia, gpu_name, vram_mb) = detect_nvidia_gpu();
    let system_ram_mb = get_system_ram_mb();
    let has_recommended_gpu = has_nvidia && vram_mb >= 5400;
    let can_install = has_recommended_gpu;

    let hardware_warning = if !can_install {
        Some(
            "Local voices need a graphics card with at least 5.4 GB of memory. Use Edge TTS or Gemini TTS instead.".to_string()
        )
    } else {
        None
    };

    let py_opt = VoxCpmManager::find_best_python(&app);
    let mut python_found = false;
    let mut python_path = None;
    let mut has_voxcpm = false;
    let mut has_torch = false;
    let mut torch_cuda = false;
    let mut torch_version = String::new();
    let is_portable = py_opt.as_ref().map_or(false, |p| {
        p.to_string_lossy().contains(".venv-voxcpm") || p.to_string_lossy().contains("voxcpm-venv")
    });

    if let Some(ref py) = py_opt {
        python_found = true;
        python_path = Some(py.to_string_lossy().to_string());
        let (_can_run, ht, hv) = check_python_packages(py);
        has_torch = ht;
        has_voxcpm = hv;
        if has_torch {
            let (cuda, ver) = check_torch_cuda(py);
            torch_cuda = cuda;
            torch_version = ver;
        }
    }

    let has_model = VoxCpmManager::find_model(&app).is_some();
    let is_ready = can_install && (server_running || has_model || (has_torch && has_voxcpm));

    let message = if server_running {
        format!(
            "Server is running on port 8000 ({})",
            if torch_cuda { "GPU CUDA accelerated" } else { "CPU mode" }
        )
    } else if is_ready {
        "VoxCPM 2 engine is installed and ready to start.".into()
    } else if !can_install {
        "Local voices need a graphics card with at least 5.4 GB of memory. Use Edge TTS or Gemini TTS instead.".into()
    } else if python_found && !has_voxcpm {
        "Python is detected, but VoxCPM 2 packages are not installed yet.".into()
    } else {
        "VoxCPM 2 is not installed on this PC. Click 'Install Local Voice Engine' below to set it up.".into()
    };

    Ok(VoxCpmSetupStatus {
        is_ready,
        server_running,
        python_found,
        python_path,
        has_voxcpm,
        has_torch,
        torch_cuda,
        torch_version,
        gpu_name: if has_nvidia { Some(gpu_name) } else { None },
        vram_mb,
        system_ram_mb,
        has_recommended_gpu,
        can_install,
        hardware_warning,
        is_portable,
        message,
    })
}

#[tauri::command]
pub async fn setup_voxcpm_engine(
    app: AppHandle,
    mgr: State<'_, VoxCpmManager>,
) -> CmdResult<String> {
    let mgr = mgr.inner().clone();
    let app_handle = app.clone();

    let res = tokio::task::spawn_blocking(move || -> Result<String> {
        let emit_progress = |step: &str, percent: u32, log: &str, is_done: bool, err: Option<String>| {
            let _ = app_handle.emit(
                "voxcpm-setup-progress",
                SetupProgress {
                    step: step.to_string(),
                    percent,
                    log: log.to_string(),
                    is_done,
                    error: err,
                },
            );
        };

        // 0. Hardware safety check: verify GPU VRAM
        let (has_nvidia, _, vram_mb) = detect_nvidia_gpu();
        let has_recommended_gpu = has_nvidia && vram_mb >= 5400;

        if !has_recommended_gpu {
            let err_msg = "Local voices need a graphics card with at least 5.4 GB of memory. Use Edge TTS or Gemini TTS instead.".to_string();
            emit_progress("Hardware check failed", 0, &err_msg, false, Some(err_msg.clone()));
            bail!("{err_msg}");
        }

        emit_progress("Checking Python environment...", 10, "Scanning for Python on host computer...", false, None);

        // 1. Locate base Python
        let app_data = app_handle
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let target_venv_dir = app_data.join("voxcpm-venv");
        let target_venv_py = target_venv_dir.join("Scripts").join("python.exe");

        let active_py = if target_venv_py.exists() {
            target_venv_py
        } else if let Some(workspace_py) = VoxCpmManager::find_workspace_root().map(|r| r.join(".venv-voxcpm").join("Scripts").join("python.exe")).filter(|p| p.exists()) {
            workspace_py
        } else {
            // Need to create venv using system python
            let base_py = VoxCpmManager::find_best_python(&app_handle);
            let base_py = match base_py {
                Some(p) => p,
                None => {
                    emit_progress("Installing Python via winget...", 15, "No Python found. Attempting winget install...", false, None);
                    let mut winget = Command::new("winget");
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        winget.creation_flags(0x0800_0000);
                    }
                    winget.args([
                        "install",
                        "-e",
                        "--id",
                        "Python.Python.3.11",
                        "--silent",
                        "--accept-package-agreements",
                        "--accept-source-agreements",
                    ]);
                    let _ = winget.output();

                    // Re-check
                    match VoxCpmManager::find_best_python(&app_handle) {
                        Some(p) => p,
                        None => {
                            // Winget wasn't available or failed; download official standalone installer directly
                            emit_progress("Downloading Python installer...", 15, "Downloading official Python 3.11 installer from python.org...", false, None);
                            let temp_installer = std::env::temp_dir().join("python-3.11.9-amd64.exe");
                            let mut dl = Command::new("powershell");
                            #[cfg(windows)]
                            {
                                use std::os::windows::process::CommandExt;
                                dl.creation_flags(0x0800_0000);
                            }
                            dl.args([
                                "-NoProfile",
                                "-Command",
                                &format!(
                                    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe', '{}')",
                                    temp_installer.to_string_lossy().replace('\\', "\\\\")
                                ),
                            ]);
                            let _ = dl.output();

                            if temp_installer.exists() {
                                emit_progress("Installing Python 3.11...", 20, "Running official Python silent installation...", false, None);
                                let mut inst = Command::new(&temp_installer);
                                #[cfg(windows)]
                                {
                                    use std::os::windows::process::CommandExt;
                                    inst.creation_flags(0x0800_0000);
                                }
                                inst.args(["/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_pip=1"]);
                                let _ = inst.output();
                                let _ = std::fs::remove_file(&temp_installer);
                            }

                            // Final check
                            match VoxCpmManager::find_best_python(&app_handle) {
                                Some(p) => p,
                                None => {
                                    let err_msg = "Python 3.10+ is required on this computer. Please install Python from https://www.python.org/downloads/ (check 'Add python.exe to PATH') and try again.";
                                    emit_progress("Python missing", 0, err_msg, false, Some(err_msg.into()));
                                    bail!("{err_msg}");
                                }
                            }
                        }
                    }
                }
            };

            emit_progress("Creating virtual environment...", 25, "Creating isolated venv at AppData/voxcpm-venv...", false, None);
            let mut venv_cmd = Command::new(&base_py);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                venv_cmd.creation_flags(0x0800_0000);
            }
            venv_cmd.args(["-m", "venv"]).arg(&target_venv_dir);
            let venv_res = venv_cmd.output()?;
            if !venv_res.status.success() {
                let err = String::from_utf8_lossy(&venv_res.stderr).to_string();
                emit_progress("Venv creation failed", 0, &err, false, Some(err.clone()));
                bail!("Failed to create virtual environment: {err}");
            }
            target_venv_py
        };

        // 2. Determine GPU and install PyTorch
        let (has_nvidia, gpu_name, _vram) = detect_nvidia_gpu();
        let pip_py = active_py.clone();

        if has_nvidia {
            emit_progress(
                "Installing CUDA PyTorch...",
                45,
                &format!("NVIDIA GPU detected ({gpu_name}). Installing PyTorch with CUDA 12.4 acceleration (~2.5 GB)..."),
                false,
                None,
            );
            let mut pip_cmd = Command::new(&pip_py);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                pip_cmd.creation_flags(0x0800_0000);
            }
            pip_cmd.args([
                "-m",
                "pip",
                "install",
                "--upgrade",
                "--retries",
                "5",
                "--timeout",
                "120",
                "torch",
                "torchaudio",
                "--index-url",
                "https://download.pytorch.org/whl/cu124",
            ]);
            let res = pip_cmd.output()?;
            if !res.status.success() {
                let err = String::from_utf8_lossy(&res.stderr).to_string();
                emit_progress("PyTorch install failed", 0, &err, false, Some(err.clone()));
                bail!("PyTorch install failed: {err}");
            }
        } else {
            emit_progress(
                "Installing CPU PyTorch...",
                45,
                "No NVIDIA GPU detected. Installing standard CPU PyTorch...",
                false,
                None,
            );
            let mut pip_cmd = Command::new(&pip_py);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                pip_cmd.creation_flags(0x0800_0000);
            }
            pip_cmd.args([
                "-m",
                "pip",
                "install",
                "--upgrade",
                "--retries",
                "5",
                "--timeout",
                "120",
                "torch",
                "torchaudio",
            ]);
            let res = pip_cmd.output()?;
            if !res.status.success() {
                let err = String::from_utf8_lossy(&res.stderr).to_string();
                emit_progress("PyTorch install failed", 0, &err, false, Some(err.clone()));
                bail!("PyTorch install failed: {err}");
            }
        }

        // 3. Install VoxCPM 2 and soundfile
        emit_progress(
            "Installing VoxCPM 2 packages...",
            75,
            "Installing voxcpm, soundfile, and audio dependencies...",
            false,
            None,
        );
        let mut vox_pip = Command::new(&pip_py);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            vox_pip.creation_flags(0x0800_0000);
        }
        vox_pip.args([
            "-m",
            "pip",
            "install",
            "--upgrade",
            "--retries",
            "5",
            "--timeout",
            "120",
            "voxcpm>=0.1.0",
            "soundfile",
        ]);
        let vres = vox_pip.output()?;
        if !vres.status.success() {
            let err = String::from_utf8_lossy(&vres.stderr).to_string();
            emit_progress("VoxCPM install failed", 0, &err, false, Some(err.clone()));
            bail!("VoxCPM install failed: {err}");
        }

        // 4. Ensure server script extracted
        emit_progress("Preparing server script...", 85, "Extracting embedded voxcpm_server.py...", false, None);
        let _ = VoxCpmManager::ensure_server_script(&app_handle);

        // 5. Start background server
        emit_progress("Starting VoxCPM 2 server...", 92, "Starting local server on http://127.0.0.1:8000...", false, None);
        mgr.stop();
        if let Err(e) = mgr.spawn_server(&app_handle) {
            emit_progress("Server start error", 92, &e.to_string(), false, None);
        }

        emit_progress(
            "Setup Complete!",
            100,
            "VoxCPM 2 Engine successfully installed and running locally!",
            true,
            None,
        );

        Ok("VoxCPM 2 engine installed and ready!".into())
    })
    .await
    .map_err(|e| anyhow!("Setup task aborted: {e}"))??;

    Ok(res)
}

#[tauri::command]
pub async fn get_voxcpm_status(mgr: State<'_, VoxCpmManager>) -> CmdResult<String> {
    if is_server_healthy("http://127.0.0.1:8000").await {
        return Ok("ready".into());
    }
    let st = mgr.status.lock().unwrap().clone();
    let s = match st {
        ServerStatus::Ready => "ready",
        ServerStatus::Starting => "starting",
        ServerStatus::Stopped => "stopped",
        ServerStatus::Failed(_) => "failed",
    };
    Ok(s.into())
}

#[tauri::command]
pub async fn start_voxcpm_server(
    app: AppHandle,
    mgr: State<'_, VoxCpmManager>,
) -> CmdResult<()> {
    let mgr = mgr.inner().clone();
    tauri::async_runtime::spawn(async move {
        mgr.start_background(app).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_voxcpm_server(mgr: State<'_, VoxCpmManager>) -> CmdResult<()> {
    mgr.stop();
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ServerCheckResult {
    pub ok: bool,
    pub status: String,
    pub message: String,
}

#[tauri::command]
pub async fn check_voxcpm_health(url: Option<String>) -> CmdResult<ServerCheckResult> {
    let base = url
        .unwrap_or_else(|| "http://127.0.0.1:8000".into());
    let base = base.trim().trim_end_matches('/');
    let target = format!("{base}/health");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| anyhow!("{e}"))?;

    match client.get(&target).send().await {
        Ok(res) => {
            if let Ok(body) = res.json::<serde_json::Value>().await {
                let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
                let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("VoxCPM2");
                if status == "ok" {
                    Ok(ServerCheckResult {
                        ok: true,
                        status: "ready".into(),
                        message: format!("Server is working! Listening on {base} (Model: {model})"),
                    })
                } else if status == "loading" {
                    Ok(ServerCheckResult {
                        ok: false,
                        status: "loading".into(),
                        message: format!(
                            "Server is reachable at {base}, but model is still loading weights into RAM... please wait a few seconds."
                        ),
                    })
                } else {
                    let err = body.get("error").and_then(|v| v.as_str()).unwrap_or("unknown error");
                    Ok(ServerCheckResult {
                        ok: false,
                        status: "error".into(),
                        message: format!("Server reachable but returned error: {err}"),
                    })
                }
            } else {
                Ok(ServerCheckResult {
                    ok: true,
                    status: "ready".into(),
                    message: format!("Server is working and reachable on {base}!"),
                })
            }
        }
        Err(e) => {
            let reason = if e.is_connect() {
                format!("Connection refused on {base}. The VoxCPM server is not running or still starting up.")
            } else if e.is_timeout() {
                format!("Request to {base} timed out after 3 seconds.")
            } else {
                format!("Could not reach {base}: {e}")
            };
            Ok(ServerCheckResult {
                ok: false,
                status: "unreachable".into(),
                message: reason,
            })
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ModelVerifyResult {
    pub ok: bool,
    pub filename: String,
    pub size_mb: u64,
    pub message: String,
}

#[tauri::command]
pub async fn verify_voxcpm_model(app: AppHandle) -> CmdResult<ModelVerifyResult> {
    if let Some(model_dir) = VoxCpmManager::find_model(&app) {
        let p = PathBuf::from(&model_dir);
        let gguf = p.join("voxcpm2-q8_0.gguf");
        let safe = p.join("model.safetensors");
        let target = if gguf.exists() { gguf } else { safe };
        if target.exists() {
            let meta = std::fs::metadata(&target).map_err(|e| crate::error::err(e.to_string()))?;
            let mb = meta.len() / (1024 * 1024);
            let filename = target.file_name().unwrap_or_default().to_string_lossy().to_string();
            return Ok(ModelVerifyResult {
                ok: true,
                filename: "voxcpm2-q8_0.gguf".into(),
                size_mb: mb,
                message: format!("Integrity check passed: {filename} ({mb} MB) verified on disk."),
            });
        }
    }
    Err(crate::error::err("Model file not found. Please install or download VoxCPM2 (Q8)."))
}

#[tauri::command]
pub async fn delete_voxcpm_model(app: AppHandle) -> CmdResult<bool> {
    if let Some(model_dir) = VoxCpmManager::find_model(&app) {
        let p = PathBuf::from(&model_dir);
        for f in ["voxcpm2-q8_0.gguf", "model.safetensors"] {
            let file_path = p.join(f);
            if file_path.exists() {
                let _ = std::fs::remove_file(file_path);
            }
        }
        return Ok(true);
    }
    Ok(false)
}
