#!/usr/bin/env python3
"""
RVC v2 (Retrieval-based Voice Conversion) CLI Runner for V-Studio.
Supports:
1. Connecting to local Applio / RVC WebUI API (http://127.0.0.1:7865 or custom).
2. Local Applio / RVC Python module inference if installed.
3. Model discovery and listing from tools/models/rvc/.
"""

import argparse
import glob
import json
import os
import shutil
import sys
import urllib.request
import urllib.error

def get_rvc_models_dir() -> str:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    models_dir = os.path.join(script_dir, "models", "rvc")
    os.makedirs(models_dir, exist_ok=True)
    return models_dir

def list_models():
    models_dir = get_rvc_models_dir()
    pth_files = glob.glob(os.path.join(models_dir, "*.pth"))
    index_files = glob.glob(os.path.join(models_dir, "*.index"))

    results = []
    for pth in pth_files:
        base_name = os.path.splitext(os.path.basename(pth))[0]
        matching_index = ""
        for idx in index_files:
            if base_name in os.path.basename(idx):
                matching_index = idx
                break
        
        size_mb = round(os.path.getsize(pth) / (1024 * 1024), 1)
        results.append({
            "name": base_name,
            "path": os.path.abspath(pth),
            "index_path": os.path.abspath(matching_index) if matching_index else "",
            "size_mb": size_mb,
        })

    print(json.dumps(results, indent=2))
    return results

def check_server_running(url: str) -> bool:
    clean_url = url.rstrip("/")
    try:
        req = urllib.request.Request(clean_url, headers={"User-Agent": "V-Studio-RVC"})
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status in (200, 302, 404, 405)
    except Exception:
        return False

def convert_via_gradio_client(server_url: str, input_path: str, output_path: str, model_name: str, pitch: int, f0_method: str, index_path: str, index_rate: float, protect: float) -> bool:
    try:
        from gradio_client import Client, handle_file
    except ImportError:
        return False

    client = Client(server_url)
    
    # Try Applio or standard RVC Gradio endpoints
    try:
        # Standard Applio / RVC endpoint prediction
        result = client.predict(
            model_name,
            pitch,
            handle_file(input_path),
            f0_method,
            index_rate,
            protect,
            api_name="/run_infer"
        )
        if result and os.path.exists(result):
            shutil.copy2(result, output_path)
            return True
    except Exception:
        pass

    try:
        result = client.predict(
            0, # speaker id
            handle_file(input_path),
            pitch,
            None,
            f0_method,
            handle_file(index_path) if (index_path and os.path.exists(index_path)) else None,
            "",
            index_rate,
            3,
            0,
            1,
            protect,
            api_name="/infer_convert"
        )
        if isinstance(result, tuple) and len(result) > 1 and os.path.exists(str(result[1])):
            shutil.copy2(str(result[1]), output_path)
            return True
        elif isinstance(result, str) and os.path.exists(result):
            shutil.copy2(result, output_path)
            return True
    except Exception:
        pass

    return False

def convert_via_rvc_module(input_path: str, output_path: str, model_path: str, pitch: int, f0_method: str, index_path: str, index_rate: float, protect: float) -> bool:
    # 1. Try Applio VoiceConverter
    try:
        from rvc.infer.infer import VoiceConverter
        vc = VoiceConverter()
        vc.convert(
            audio_input_path=input_path,
            audio_output_path=output_path,
            model_path=model_path,
            index_path=index_path if (index_path and os.path.exists(index_path)) else "",
            pitch=pitch,
            f0_method=f0_method,
            index_rate=index_rate,
            protect_voiceless=protect,
        )
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            return True
    except Exception as e:
        pass

    # 2. Try classic RVC VC module
    try:
        from rvc.modules.vc.modules import VC
        vc = VC()
        vc.get_vc(model_path)
        tgt_sr, audio_opt, times, error = vc.vc_single(
            sid=0,
            input_audio_path=input_path,
            f0_up_key=pitch,
            f0_method=f0_method,
            file_index=index_path if (index_path and os.path.exists(index_path)) else "",
            index_rate=index_rate,
            protect=protect
        )
        if audio_opt is not None:
            import soundfile as sf
            sf.write(output_path, audio_opt, tgt_sr)
            return True
    except Exception as e:
        pass

    return False

def run_conversion(input_path: str, output_path: str, model_path: str, pitch: int = 0, f0_method: str = "rmvpe", index_path: str = "", index_rate: float = 0.75, protect: float = 0.33, server_url: str = ""):
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input audio file not found: {input_path}")

    # Resolve model path if only name is given
    if not os.path.exists(model_path):
        candidate = os.path.join(get_rvc_models_dir(), model_path)
        if os.path.exists(candidate):
            model_path = candidate
        elif os.path.exists(candidate + ".pth"):
            model_path = candidate + ".pth"

    # If index path is not specified, auto-check matching index
    if not index_path and os.path.exists(model_path):
        base_name = os.path.splitext(model_path)[0]
        if os.path.exists(base_name + ".index"):
            index_path = base_name + ".index"

    model_name = os.path.splitext(os.path.basename(model_path))[0] if model_path else ""

    # Strategy 1: If server URL is provided and running, use API
    if server_url and check_server_running(server_url):
        ok = convert_via_gradio_client(
            server_url=server_url,
            input_path=input_path,
            output_path=output_path,
            model_name=model_name,
            pitch=pitch,
            f0_method=f0_method,
            index_path=index_path,
            index_rate=index_rate,
            protect=protect,
        )
        if ok and os.path.exists(output_path):
            print(f"[RVC] Successfully converted via RVC Server ({server_url}) -> {output_path}")
            return

    # Strategy 2: If default local server (http://127.0.0.1:7865) is running
    if check_server_running("http://127.0.0.1:7865"):
        ok = convert_via_gradio_client(
            server_url="http://127.0.0.1:7865",
            input_path=input_path,
            output_path=output_path,
            model_name=model_name,
            pitch=pitch,
            f0_method=f0_method,
            index_path=index_path,
            index_rate=index_rate,
            protect=protect,
        )
        if ok and os.path.exists(output_path):
            print(f"[RVC] Successfully converted via local RVC WebUI -> {output_path}")
            return

    # Strategy 3: Local Python module
    if model_path and os.path.exists(model_path):
        ok = convert_via_rvc_module(
            input_path=input_path,
            output_path=output_path,
            model_path=model_path,
            pitch=pitch,
            f0_method=f0_method,
            index_path=index_path,
            index_rate=index_rate,
            protect=protect,
        )
        if ok and os.path.exists(output_path):
            print(f"[RVC] Successfully converted via local RVC engine -> {output_path}")
            return

    # If neither succeeded, check what is missing and raise helpful error
    if not model_path or not os.path.exists(model_path):
        raise ValueError(
            f"RVC model (.pth) not found! Place your .pth voice model into: '{get_rvc_models_dir()}' or select an existing file."
        )

    raise RuntimeError(
        "RVC conversion failed. To use RVC v2 locally:\n"
        "1. Start Applio or RVC WebUI on your PC (http://127.0.0.1:7865), OR\n"
        "2. Ensure your chosen .pth model is loaded in Settings."
    )

def main():
    parser = argparse.ArgumentParser(description="V-Studio RVC v2 runner")
    parser.add_argument("--list-models", action="store_true", help="List all RVC .pth models in tools/models/rvc")
    parser.add_argument("--input", help="Path to input audio file")
    parser.add_argument("--output", help="Path to output audio file")
    parser.add_argument("--model", default="", help="Path to .pth voice model")
    parser.add_argument("--index", default="", help="Path to .index feature file")
    parser.add_argument("--pitch", type=int, default=0, help="Pitch shift in semitones (-14 to +14)")
    parser.add_argument("--f0-method", default="rmvpe", choices=["rmvpe", "pm", "crepe", "harvest"], help="Pitch algorithm")
    parser.add_argument("--index-rate", type=float, default=0.75, help="Index influence rate (0.0 - 1.0)")
    parser.add_argument("--protect", type=float, default=0.33, help="Protect voiceless consonants (0.0 - 0.5)")
    parser.add_argument("--server-url", default="", help="RVC WebUI/Applio API server URL (e.g. http://127.0.0.1:7865)")
    parser.add_argument("--check-server", help="Check if RVC server is reachable at given URL")

    args = parser.parse_args()

    if args.list_models:
        list_models()
        return

    if args.check_server:
        is_up = check_server_running(args.check_server)
        print(json.dumps({"url": args.check_server, "available": is_up}))
        return

    if not args.input or not args.output:
        parser.error("--input and --output are required for voice conversion")

    run_conversion(
        input_path=args.input,
        output_path=args.output,
        model_path=args.model,
        pitch=args.pitch,
        f0_method=args.f0_method,
        index_path=args.index,
        index_rate=args.index_rate,
        protect=args.protect,
        server_url=args.server_url,
    )

if __name__ == "__main__":
    main()
