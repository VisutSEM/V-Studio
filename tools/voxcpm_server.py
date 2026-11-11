#!/usr/bin/env python3
"""Minimal OpenAI-compatible TTS server for VoxCPM 2.

VoxCPM ships a Gradio web demo, not a REST API, and its production server
(vLLM-Omni) is Linux-only.  This script exposes the same
``POST /v1/audio/speech`` contract as vLLM-Omni using the ``voxcpm`` Python
package, so VideoGen works the same way on Windows.

    pip install voxcpm
    python tools/voxcpm_server.py

Endpoints
---------
POST /v1/audio/speech
    {"model": "openbmb/VoxCPM2", "input": "text", "voice": "default",
     "response_format": "wav",
     "ref_audio": "data:audio/wav;base64,...",   # optional
     "ref_text": "transcript of ref audio",       # optional
     "extra_params": {"cfg_value": 2.0, "inference_timesteps": 10}}

GET /health
GET /v1/models

The model is loaded once at startup.  ``input`` may carry a VoxCPM2 control
instruction as a ``(voice description)`` prefix, exactly like the upstream CLI.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import mimetypes
import os
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

MAX_BODY = 64 * 1024 * 1024  # reference audio is sent inline as base64

_model = None
_sample_rate = 48000
_model_id = "openbmb/VoxCPM2"
_generate_lock = threading.Lock()
_args = None
_low_memory = False
_load_error = None


def log(msg: str) -> None:
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        # Windows consoles default to cp1252; never let logging kill a request.
        encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
        print(msg.encode(encoding, "replace").decode(encoding, "replace"), flush=True)


def total_ram_gb() -> float | None:
    try:
        if os.name == "nt":
            import ctypes

            class MemoryStatus(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = MemoryStatus()
            status.dwLength = ctypes.sizeof(status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return status.ullTotalPhys / 1e9
        else:
            with open("/proc/meminfo", encoding="ascii") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        return int(line.split()[1]) / 1e6
    except Exception:  # noqa: BLE001
        pass
    return None


def install_low_memory_loader() -> None:
    """Load VoxCPM 2 without ever holding two full copies of the weights.

    ``VoxCPM2Model.from_local`` builds the model in float32 (~9 GB), converts it
    and then loads the whole safetensors file into another dict, so it peaks
    around 14 GB of RAM.  With this patch the model is built directly in bf16
    and tensor data is memory-mapped and copied in one tensor at a time.
    """
    global _low_memory

    import torch
    from safetensors import safe_open
    import voxcpm.model.voxcpm2 as voxcpm2

    class LazyStateDict:
        def __init__(self, path: str) -> None:
            self._file = safe_open(path, framework="pt", device="cpu")
            self._keys = list(self._file.keys())
            self._extra: dict[str, object] = {}

        def keys(self):
            return list(self._keys) + list(self._extra)

        def __iter__(self):
            return iter(self.keys())

        def __len__(self):
            return len(self._keys) + len(self._extra)

        def __contains__(self, key):
            return key in self._extra or key in self._keys

        def __getitem__(self, key):
            if key in self._extra:
                return self._extra[key]
            return self._file.get_tensor(key)

        def __setitem__(self, key, value):
            self._extra[key] = value

        def get(self, key, default=None):
            try:
                return self[key]
            except KeyError:
                return default

        def items(self):
            for key in self.keys():
                yield key, self[key]

    def load_file(path, device="cpu"):
        return LazyStateDict(path)

    original_load_state_dict = torch.nn.Module.load_state_dict

    def load_state_dict(self, state_dict, strict=True, assign=False):
        if not isinstance(state_dict, LazyStateDict):
            return original_load_state_dict(self, state_dict, strict=strict, assign=assign)

        # Same walk as torch's implementation, but without `OrderedDict(state_dict)`
        # which would copy every weight into RAM at once.
        missing_keys: list[str] = []
        unexpected_keys: list[str] = []
        error_msgs: list[str] = []
        metadata = {} if not assign else {"assign_to_params_buffers": True}

        def load(module, prefix=""):
            module._load_from_state_dict(
                state_dict, prefix, metadata, strict, missing_keys,
                unexpected_keys, error_msgs,
            )
            for name, child in module._modules.items():
                if child is not None:
                    load(child, prefix + name + ".")

        load(self)
        if strict and (missing_keys or unexpected_keys):
            raise RuntimeError(
                f"Error(s) in loading state_dict: missing={missing_keys[:5]} "
                f"unexpected={unexpected_keys[:5]}"
            )
        return torch.nn.modules.module._IncompatibleKeys(missing_keys, unexpected_keys)

    voxcpm2.load_file = load_file
    torch.nn.Module.load_state_dict = load_state_dict
    torch.set_default_dtype(torch.bfloat16)
    _low_memory = True
    log("Low-memory loader enabled (bf16 construction, streamed weights).")


def default_dtype(dtype: str) -> None:
    if not _low_memory:
        return
    import torch

    torch.set_default_dtype(getattr(torch, dtype))




def load_model(model_id: str, device: str, denoise: bool, optimize: bool) -> None:
    global _model, _sample_rate, _model_id

    from voxcpm import VoxCPM

    resolved_device = device
    try:
        import torch

        if device.strip().lower() in ("auto", "cuda", "cuda:0"):
            if torch.cuda.is_available():
                total = torch.cuda.get_device_properties(0).total_memory / 1e9
                gpu_name = torch.cuda.get_device_name(0)
                resolved_device = "cuda"
                log(f"NVIDIA GPU Active: {gpu_name} ({total:.1f} GB VRAM) - Using CUDA acceleration (10x faster)!")
            else:
                resolved_device = "cpu"
                log("PyTorch running in CPU mode (CUDA not detected in current torch install).")
    except Exception:
        resolved_device = "cpu"

    log(f"Loading {model_id} (target_device={device}, resolved={resolved_device}) - loading weights...")
    default_dtype("bfloat16")
    try:
        _model = VoxCPM.from_pretrained(
            model_id,
            load_denoiser=denoise,
            device=resolved_device,
            optimize=optimize,
        )
    except Exception as exc:  # noqa: BLE001
        wanted_gpu = not resolved_device.strip().lower().startswith("cpu")
        if not wanted_gpu:
            raise
        log(f"Could not load on {resolved_device}: {exc}")
        log("Falling back to CPU - generation will be safe but slower.")
        try:
            import torch

            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
        default_dtype("bfloat16")
        _model = VoxCPM.from_pretrained(
            model_id,
            load_denoiser=denoise,
            device="cpu",
            optimize=optimize,
        )
    default_dtype("float32")
    _model_id = model_id
    _sample_rate = int(getattr(_model.tts_model, "sample_rate", 48000) or 48000)
    log(f"VoxCPM ready - {_sample_rate} Hz. POST /v1/audio/speech")


def temp_file(suffix: str, data: bytes) -> str:
    fd, path = tempfile.mkstemp(prefix="voxcpm_ref_", suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


def resolve_ref_audio(ref: str) -> tuple[str, bool]:
    """Return (local path, should_delete).

    Accepts a data URI, an http(s) URL, a file:// URI or a local path.
    """
    ref = ref.strip()

    if ref.startswith("data:"):
        header, _, payload = ref.partition(",")
        if not payload:
            raise ValueError("ref_audio data URI has no payload")
        mime = header[5:].split(";", 1)[0] or "audio/wav"
        suffix = mimetypes.guess_extension(mime) or ".wav"
        try:
            data = base64.b64decode(payload, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"invalid ref_audio data URI: {exc}") from exc
        return temp_file(suffix, data), True

    if ref.startswith(("http://", "https://")):
        try:
            with urllib.request.urlopen(ref, timeout=60) as resp:
                data = resp.read(MAX_BODY)
                mime = resp.headers.get_content_type() or "audio/wav"
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"could not download ref_audio: {exc}") from exc
        suffix = mimetypes.guess_extension(mime) or ".wav"
        return temp_file(suffix, data), True

    if ref.startswith("file://"):
        path = urlparse(ref).path
        if os.name == "nt" and path.startswith("/"):
            path = path.lstrip("/")
        path = unquote(path)
    else:
        path = ref

    if not os.path.exists(path):
        raise ValueError(f"reference audio not found: {path}")
    return path, False


def prepare_ref_clip(path: str, max_seconds: float = 4.5) -> tuple[str, bool]:
    """Ensure the reference clip is clamped to max_seconds to prevent CPU memory exhaustion and speed up attention."""
    import soundfile as sf

    try:
        info = sf.info(path)
        if info.duration > max_seconds:
            log(
                f"Trimming reference audio from {info.duration:.1f}s down to {max_seconds:.1f}s for faster laptop processing"
            )
            max_frames = int(info.samplerate * max_seconds)
            data, sr = sf.read(path, frames=max_frames, dtype="float32")
            fd, trimmed_path = tempfile.mkstemp(prefix="voxcpm_trimmed_", suffix=".wav")
            os.close(fd)
            sf.write(trimmed_path, data, sr, format="WAV", subtype="PCM_16")
            return trimmed_path, True
    except Exception as exc:  # noqa: BLE001
        log(f"Warning: could not inspect/trim reference audio {path}: {exc}")
    return path, False


def synthesize(payload: dict) -> bytes:
    import gc
    import soundfile as sf
    import torch

    text = payload.get("input")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("input text cannot be empty")

    extra = payload.get("extra_params") or {}
    if not isinstance(extra, dict):
        raise ValueError("extra_params must be an object")
    cfg = float(extra.get("cfg_value", _args.cfg))
    steps = int(extra.get("inference_timesteps", _args.steps))
    # Cap steps for laptop optimization (4–20 steps, default 6)
    steps = max(4, min(steps, 20))
    seed = payload.get("seed")
    seed = int(seed) if seed is not None else None

    ref_audio = payload.get("ref_audio")
    ref_text = payload.get("ref_text")
    kwargs = {
        "text": text,
        "cfg_value": cfg,
        "inference_timesteps": steps,
        "denoise": bool(_args.denoise),
    }

    if seed is not None:
        # voxcpm's generate() has no seed argument; seed the RNGs instead so a
        # designed voice stays consistent across calls.
        import random
        import numpy as np

        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)

    temp_path = None
    delete_ref = False
    trimmed_path = None
    delete_trimmed = False
    try:
        if ref_audio:
            temp_path, delete_ref = resolve_ref_audio(str(ref_audio))
            active_ref, delete_trimmed = prepare_ref_clip(temp_path, max_seconds=4.5)
            if delete_trimmed:
                trimmed_path = active_ref

            if isinstance(ref_text, str) and ref_text.strip():
                # Ultimate cloning: the reference clip becomes a spoken prefix.
                kwargs["prompt_wav_path"] = active_ref
                kwargs["prompt_text"] = ref_text.strip()
            else:
                # Controllable cloning: timbre only.
                kwargs["reference_wav_path"] = active_ref

        with _generate_lock:
            # Use torch.inference_mode() for lowest latency and zero gradient/view tracking memory
            with torch.inference_mode():
                wav = _model.generate(**kwargs)
    finally:
        if trimmed_path and delete_trimmed:
            try:
                os.remove(trimmed_path)
            except OSError:
                pass
        if temp_path and delete_ref:
            try:
                os.remove(temp_path)
            except OSError:
                pass
        # Immediate memory cleanup prevents RAM bloat on 8 GB laptops
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    buf = io.BytesIO()
    sf.write(buf, wav, _sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


_mms_model = None
_mms_tokenizer = None
_mms_lock = threading.Lock()


def get_mms_server():
    global _mms_model, _mms_tokenizer
    with _mms_lock:
        if _mms_model is None:
            import torch
            from transformers import VitsModel, AutoTokenizer
            try:
                _mms_model = VitsModel.from_pretrained("facebook/mms-tts-khm", local_files_only=True)
                _mms_tokenizer = AutoTokenizer.from_pretrained("facebook/mms-tts-khm", local_files_only=True)
            except Exception:
                _mms_model = VitsModel.from_pretrained("facebook/mms-tts-khm")
                _mms_tokenizer = AutoTokenizer.from_pretrained("facebook/mms-tts-khm")
            _mms_model.eval()
        return _mms_model, _mms_tokenizer


def synthesize_mms(payload: dict) -> bytes:
    import io
    import soundfile as sf
    import torch

    text = payload.get("input", "").strip()
    if not text:
        raise ValueError("input text cannot be empty")
    model, tokenizer = get_mms_server()
    inputs = tokenizer(text, return_tensors="pt")
    with torch.no_grad():
        output = model(**inputs).waveform

    waveform = output.squeeze().cpu().numpy()
    buf = io.BytesIO()
    sf.write(buf, waveform, model.config.sampling_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def synthesize_edge(payload: dict) -> bytes:
    import asyncio
    import edge_tts

    text = payload.get("input", "").strip()
    if not text:
        raise ValueError("input text cannot be empty")

    voice = payload.get("voice") or "km-KH-SreymomNeural"
    if voice == "default":
        voice = "km-KH-SreymomNeural"
    slow = payload.get("slow", False)
    rate = "-10%" if slow else "+0%"
    pitch = "-2Hz" if slow else "+0Hz"

    async def _run(v: str):
        comm = edge_tts.Communicate(text, v, rate=rate, pitch=pitch)
        chunks = []
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        return b"".join(chunks)

    # Try preferred voice; fallback to km-KH-SreymomNeural if needed
    for v in [voice, "km-KH-SreymomNeural"]:
        try:
            data = asyncio.run(_run(v))
            if data:
                return data
        except Exception:
            continue

    raise RuntimeError("Edge TTS returned empty audio")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "VoxCPM2-Local/1.0"

    def _send(self, status: int, body: bytes, mime: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, obj: dict) -> None:
        self._send(status, json.dumps(obj).encode("utf-8"), "application/json")

    def _error(self, status: int, message: str) -> None:
        self._json(
            status,
            {"error": {"message": message, "type": "invalid_request_error"}},
        )

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/health", "/healthz"):
            self._json(
                200 if _model is not None else (503 if _load_error else 200),
                {
                    "status": "ok" if _model is not None else ("error" if _load_error else "loading"),
                    "model": _model_id,
                    "sample_rate": _sample_rate,
                    "error": str(_load_error) if _load_error else None,
                },
            )
        elif path == "/v1/models":
            self._json(
                200,
                {
                    "object": "list",
                    "data": [{"id": _model_id, "object": "model", "owned_by": "local"}],
                },
            )
        elif path == "/":
            self._send(
                200,
                b"VoxCPM2 local server. POST /v1/audio/speech\n",
                "text/plain; charset=utf-8",
            )
        else:
            self._error(404, f"unknown path {path}")

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path not in ("/v1/audio/speech", "/audio/speech"):
            self._error(404, f"unknown path {path}")
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._error(400, "empty request body")
            return
        if length > MAX_BODY:
            self._error(413, "request body too large")
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._error(400, f"invalid JSON: {exc}")
            return
        if not isinstance(payload, dict):
            self._error(400, "request body must be a JSON object")
            return

        engine = str(payload.get("engine", "")).lower()
        model_str = str(payload.get("model", "")).lower()

        if engine == "edge_tts" or "edge" in model_str:
            log(f"Edge TTS {str(payload.get('input', ''))[:80]!r}")
            try:
                audio = synthesize_edge(payload)
                self._send(200, audio, "audio/mpeg")
                log(f"  -> {len(audio):,} bytes MP3")
                return
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                self._error(500, f"Edge TTS error: {exc}")
                return

        if engine == "meta_mms" or "mms" in model_str:
            log(f"Meta MMS {str(payload.get('input', ''))[:80]!r}")
            try:
                audio = synthesize_mms(payload)
                self._send(200, audio, "audio/wav")
                log(f"  -> {len(audio):,} bytes WAV")
                return
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                self._error(500, f"Meta MMS error: {exc}")
                return

        # Wait for model if still loading (up to 90 seconds)
        start_wait = time.time()
        while _model is None and _load_error is None and (time.time() - start_wait < 90):
            time.sleep(0.5)

        if _load_error is not None:
            self._error(500, f"model failed to load: {_load_error}")
            return

        if _model is None:
            self._error(503, "model is still loading - please wait a moment and try again")
            return

        log(
            "TTS %r (ref_audio=%s, ref_text=%s)"
            % (
                str(payload.get("input", ""))[:80],
                "yes" if payload.get("ref_audio") else "no",
                "yes" if payload.get("ref_text") else "no",
            )
        )
        try:
            audio = synthesize(payload)
        except ValueError as exc:
            self._error(400, str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            message = f"{type(exc).__name__}: {exc}"
            if "out of memory" in message.lower():
                message += (
                    " - the GPU is too small for VoxCPM 2 (needs about 8 GB). "
                    "Restart the server with --device cpu (much slower)."
                )
            self._error(500, message)
            return

        self._send(
            200,
            audio,
            "audio/wav",
            {
                "x-audio-sample-rate": str(_sample_rate),
                "x-audio-channels": "1",
            },
        )
        log(f"  -> {len(audio):,} bytes WAV")


def main() -> None:
    global _args

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(description="OpenAI-compatible VoxCPM 2 server")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="port (default 8000)")
    parser.add_argument("--model", default="openbmb/VoxCPM2", help="HF id or local model folder")
    parser.add_argument(
        "--device", default="auto", help="auto | cpu | cuda | cuda:0 | mps"
    )
    parser.add_argument(
        "--cfg", type=float, default=2.0, help="default CFG guidance scale (1.0–3.0)"
    )
    parser.add_argument(
        "--steps", type=int, default=6, help="default inference timesteps (recommended: 5–8 for laptops, default: 6)"
    )
    parser.add_argument(
        "--denoise",
        action="store_true",
        help="load ZipEnhancer and denoise prompt/reference audio",
    )
    parser.add_argument(
        "--no-optimize",
        action="store_true",
        help="disable torch.compile (use if startup crashes)",
    )
    parser.add_argument(
        "--low-memory",
        action="store_true",
        help="build in bf16 and stream weights (needed below ~12 GB RAM)",
    )
    parser.add_argument(
        "--no-low-memory",
        action="store_true",
        help="always use the library's default loader",
    )
    _args = parser.parse_args()

    try:
        import voxcpm  # noqa: F401
    except ImportError:
        sys.exit(
            "voxcpm is not installed. Run:\n"
            "  pip install voxcpm\n"
            "Use a Python 3.11/3.12 virtual environment."
        )

    # Laptop CPU Optimization: optimize compute threads to avoid E-core thrashing
    import torch
    num_cpus = os.cpu_count() or 8
    target_threads = min(8, max(4, num_cpus // 2))
    torch.set_num_threads(target_threads)
    torch.set_num_interop_threads(2)
    log(f"Laptop CPU threading tuned: {target_threads} compute threads (system: {num_cpus} logical CPUs)")

    ram = total_ram_gb()
    if ram is not None:
        log(f"System RAM: {ram:.1f} GB")
    want_low = _args.low_memory or (
        not _args.no_low_memory and ram is not None and ram < 12
    )
    if want_low:
        install_low_memory_loader()

    def load_task() -> None:
        global _load_error
        try:
            load_model(_args.model, _args.device, _args.denoise, not _args.no_optimize)
        except Exception as exc:  # noqa: BLE001
            _load_error = exc
            log(f"Error loading model: {exc}")

    threading.Thread(target=load_task, daemon=True).start()

    server = ThreadingHTTPServer((_args.host, _args.port), Handler)
    log(f"Listening on http://{_args.host}:{_args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("\nStopped.")


if __name__ == "__main__":
    main()
