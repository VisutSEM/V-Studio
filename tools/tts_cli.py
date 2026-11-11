#!/usr/bin/env python3
"""CLI utility for Edge TTS and Meta MMS synthesis in VideoGen."""

import argparse
import asyncio
import os
import sys

def run_edge_tts(text: str, voice: str, out_path: str, slow: bool = False) -> None:
    import edge_tts

    rate = "-10%" if slow else "+0%"
    pitch = "-2Hz" if slow else "+0Hz"
    
    # Try preferred voice; fallback to km-KH-SreymomNeural if it fails
    voices_to_try = [voice]
    if voice != "km-KH-SreymomNeural":
        voices_to_try.append("km-KH-SreymomNeural")

    last_err = None
    for v in voices_to_try:
        try:
            async def _synth():
                comm = edge_tts.Communicate(text, v, rate=rate, pitch=pitch)
                await comm.save(out_path)
            asyncio.run(_synth())
            if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                return
        except Exception as e:
            last_err = e
            continue

    if last_err:
        raise last_err
    raise RuntimeError(f"Edge TTS failed to produce audio at {out_path}")


_mms_model = None
_mms_tokenizer = None

def get_mms():
    global _mms_model, _mms_tokenizer
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


def run_meta_mms(text: str, out_path: str, slow: bool = False) -> None:
    import torch
    import soundfile as sf

    model, tokenizer = get_mms()
    inputs = tokenizer(text, return_tensors="pt")
    with torch.no_grad():
        output = model(**inputs).waveform

    waveform = output.squeeze().cpu().numpy()
    sf.write(out_path, waveform, model.config.sampling_rate)


def run_kiri_tts(text: str, voice: str, out_path: str, api_key: str, base_url: str = "https://api.kiritts.com/v1", slow: bool = False) -> None:
    import json
    import urllib.request

    if not api_key:
        raise ValueError("Missing Kiri TTS API key")

    url = f"{base_url.rstrip('/')}/audio/speech"
    speed = 0.85 if slow else 1.0
    payload = json.dumps({
        "model": "kiritts",
        "input": text,
        "voice": voice or "Maly",
        "response_format": "mp3",
        "speed": speed,
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key.strip()}",
            "Content-Type": "application/json",
            "User-Agent": "VideoGen/0.1.0",
        },
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=45) as resp:
        audio_data = resp.read()

    with open(out_path, "wb") as f:
        f.write(audio_data)


def main():
    parser = argparse.ArgumentParser(description="VideoGen TTS runner")
    parser.add_argument("--engine", choices=["edge_tts", "meta_mms", "kiri_tts"], required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--voice", default="km-KH-SreymomNeural")
    parser.add_argument("--api-key", default="")
    parser.add_argument("--base-url", default="https://api.kiritts.com/v1")
    parser.add_argument("--slow", action="store_true")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    if args.engine == "edge_tts":
        run_edge_tts(args.text, args.voice, args.out, args.slow)
    elif args.engine == "meta_mms":
        run_meta_mms(args.text, args.out, args.slow)
    elif args.engine == "kiri_tts":
        run_kiri_tts(args.text, args.voice, args.out, args.api_key, args.base_url, args.slow)
    else:
        raise ValueError(f"Unknown engine: {args.engine}")

    print(f"OK {os.path.getsize(args.out)} bytes")


if __name__ == "__main__":
    main()
