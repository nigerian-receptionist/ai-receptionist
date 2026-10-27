"""Local browser UI for speaking with the voice-lab assistant."""

from __future__ import annotations

import base64
import io
import json
import os
import tempfile
import wave
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from voicelab.live_demo import _llm_reply
from voicelab.model_registry import create_stt_adapter, create_tts_adapter
from voicelab.privacy import redact_for_storage

WEB_DIR = Path(__file__).resolve().parents[2] / "web"
app = FastAPI(title="Voice Lab", docs_url=None, redoc_url=None)


class TurnRequest(BaseModel):
    audio_wav_base64: str
    sample_rate: int = Field(ge=8000, le=48000)
    stt_model: str = Field(pattern="^(stt_underdog_bark|stt_fw_small)$")
    tts_model: str = Field(pattern="^(tts_kokoro|tts_yarngpt2)$")
    voice_id: str = Field(min_length=1, max_length=100)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=12)


@lru_cache(maxsize=2)
def _stt(model_id: str):
    return create_stt_adapter(model_id)


@lru_cache(maxsize=2)
def _tts(model_id: str):
    return create_tts_adapter(model_id)


def _authorized_yarn_voices() -> list[str]:
    directory = Path(
        os.getenv("YARNGPT2_SPEAKERS_DIR", "models/yarngpt2/speakers")
    ).expanduser()
    allowed: list[str] = []
    if directory.is_dir():
        for profile_path in sorted(directory.glob("*.json")):
            try:
                profile = json.loads(profile_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if profile.get("voice_use_authorized") is True and profile.get("consent_id"):
                allowed.append(profile_path.stem)
    return allowed


@app.get("/")
def home() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/api/status")
def status() -> dict[str, Any]:
    model = os.getenv("LITELLM_MODEL", "ollama/qwen2.5:3b")
    base_url = os.getenv("LITELLM_BASE_URL", "http://localhost:11434").rstrip("/")
    try:
        import urllib.request

        with urllib.request.urlopen(f"{base_url}/api/tags", timeout=2) as response:
            data = json.loads(response.read())
        installed = [item.get("name", "") for item in data.get("models", [])]
        target = model.removeprefix("ollama/")
        ready = any(name == target or name.startswith(f"{target}:") for name in installed)
    except Exception:
        installed = []
        ready = False
    return {
        "ollama_ready": ready,
        "ollama_model": model,
        "ollama_url": base_url,
        "yarn_voices": _authorized_yarn_voices(),
    }


@app.post("/api/turn")
def turn(request: TurnRequest) -> dict[str, Any]:
    try:
        audio_bytes = base64.b64decode(request.audio_wav_base64, validate=True)
        with wave.open(io.BytesIO(audio_bytes), "rb") as reader:
            if reader.getnchannels() != 1 or reader.getsampwidth() != 2:
                raise ValueError("Audio must be mono 16-bit PCM WAV")
            if reader.getframerate() != request.sample_rate:
                raise ValueError("Audio sample rate does not match the WAV header")
            if reader.getnframes() / reader.getframerate() > 60:
                raise ValueError("Keep each recording under 60 seconds")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            audio_path = Path(handle.name)
            handle.write(audio_bytes)
        try:
            stt_result = _stt(request.stt_model).transcribe_file(
                str(audio_path), language="en"
            )
        finally:
            audio_path.unlink(missing_ok=True)

        transcript = stt_result.text.strip()
        if not transcript:
            raise HTTPException(
                status_code=422,
                detail="I couldn't make out any speech. Try again.",
            )
        safe_transcript = redact_for_storage(transcript)
        safe_history = [
            {"role": entry["role"], "content": entry["content"][:2000]}
            for entry in request.history[-10:]
            if entry.get("role") in {"user", "assistant"}
            and isinstance(entry.get("content"), str)
        ]
        try:
            reply, _, _ = _llm_reply(
                safe_transcript,
                safe_history,
                model=os.getenv("LITELLM_MODEL", "ollama/qwen2.5:3b"),
                first_token_callback=lambda _: None,
            )
        except Exception as error:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Ollama couldn't answer ({type(error).__name__}). "
                    "Check that Ollama is running "
                    "and that the configured model is installed."
                ),
            ) from error
        reply = reply or "I didn't get a response. Please try again."
        tts = _tts(request.tts_model)
        if (
            request.tts_model == "tts_yarngpt2"
            and request.voice_id not in _authorized_yarn_voices()
        ):
            raise HTTPException(
                status_code=400,
                detail="Choose a YarnGPT2 profile with documented voice authorization.",
            )
        language = os.getenv("DEMO_LANGUAGE", "en-NG")
        audio = tts.synthesize(reply, voice_id=request.voice_id, language=language)
        output = io.BytesIO()
        with wave.open(output, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(audio.sample_rate)
            writer.writeframes(audio.pcm_s16le)
        return {
            "transcript": safe_transcript,
            "reply": redact_for_storage(reply),
            "audio_wav_base64": base64.b64encode(output.getvalue()).decode("ascii"),
        }
    except HTTPException:
        raise
    except (ValueError, wave.Error, base64.binascii.Error) as error:
        raise HTTPException(status_code=400, detail=f"Invalid recording: {error}") from error
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=(
                "The selected speech model couldn't process this turn "
                f"({type(error).__name__})."
            ),
        ) from error
