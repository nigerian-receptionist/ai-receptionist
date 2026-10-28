"""Local browser UI for speaking with the voice-lab assistant."""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import tempfile
import time
import wave
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from voicelab.live_demo import SYSTEM_MESSAGE, _llm_reply
from voicelab.model_registry import create_stt_adapter, create_tts_adapter
from voicelab.privacy import redact_for_storage

WEB_DIR = Path(__file__).resolve().parents[2] / "web"
app = FastAPI(title="Voice Lab", docs_url=None, redoc_url=None)
logger = logging.getLogger(__name__)


class TurnRequest(BaseModel):
    audio_wav_base64: str
    sample_rate: int = Field(ge=8000, le=48000)
    stt_model: str = Field(pattern="^(stt_underdog_bark|stt_fw_small|stt_fw_tiny)$")
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
    whisper_cache = Path(
        os.getenv("WHISPER_CACHE_DIR") or Path.home() / ".cache" / "whisper"
    )
    whisper_small_ready = (whisper_cache / "small.pt").is_file()
    whisper_tiny_ready = (whisper_cache / "tiny.pt").is_file()
    kokoro_model = Path(os.getenv("KOKORO_MODEL_PATH", "models/kokoro/kokoro-v1.0.onnx"))
    kokoro_voices = Path(os.getenv("KOKORO_VOICES_PATH", "models/kokoro/voices-v1.0.bin"))
    kokoro_ready = kokoro_model.is_file() and kokoro_voices.is_file()
    try:
        from huggingface_hub import hf_hub_download

        hf_hub_download(
            repo_id="ConwayResearch/Underdog-Bark-3.0",
            filename="bark_loader.py",
            revision="85db2ad",
            local_files_only=True,
        )
        hf_hub_download(
            repo_id="ConwayResearch/Underdog-Bark-3.0",
            filename="model.bark",
            revision="85db2ad",
            local_files_only=True,
        )
        for filename in (
            "config.json",
            "generation_config.json",
            "processor_config.json",
            "tokenizer.json",
            "tokenizer_config.json",
        ):
            hf_hub_download(
                repo_id="nvidia/parakeet-tdt-0.6b-v3",
                filename=filename,
                local_files_only=True,
            )
        bark_ready = True
    except Exception:
        bark_ready = False
    hub_offline = os.getenv("HF_HUB_OFFLINE", "false").lower() in {"1", "true", "yes"}
    bark_reason = "" if bark_ready else "Bark or its Parakeet processor files are not cached."
    yarn_voices = _authorized_yarn_voices()
    codec_config = Path(
        os.getenv("WAVTOKENIZER_CONFIG_PATH", "models/wavtokenizer/wavtokenizer-config.yaml")
    )
    codec_checkpoint = Path(
        os.getenv(
            "WAVTOKENIZER_CHECKPOINT_PATH",
            "models/wavtokenizer/wavtokenizer-checkpoint.ckpt",
        )
    )
    codec_root = Path(os.getenv("WAVTOKENIZER_ROOT", "models/wavtokenizer/WavTokenizer"))
    hub_cache = Path(
        os.getenv("HF_HUB_CACHE")
        or Path(os.getenv("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub"
    )
    yarn_cache = hub_cache / "models--saheedniyi--YarnGPT2"
    yarn_model_cached = any(
        (snapshot / "config.json").is_file()
        and any(
            (snapshot / filename).is_file()
            for filename in ("model.safetensors", "pytorch_model.bin")
        )
        for snapshot in (yarn_cache / "snapshots").glob("*")
    ) if (yarn_cache / "snapshots").is_dir() else False
    yarn_ready = (
        bool(yarn_voices)
        and codec_config.is_file()
        and codec_checkpoint.is_file()
        and codec_root.is_dir()
        and yarn_model_cached
    )
    if yarn_ready:
        yarn_reason = ""
    elif not yarn_voices:
        yarn_reason = "YarnGPT2 needs a locally consented and authorized speaker profile."
    elif not (codec_config.is_file() and codec_checkpoint.is_file() and codec_root.is_dir()):
        yarn_reason = "YarnGPT2 is missing its WavTokenizer source or codec files."
    elif not yarn_model_cached and hub_offline:
        yarn_reason = (
            "YarnGPT2 weights are missing from the local cache and "
            "HF_HUB_OFFLINE is enabled."
        )
    else:
        yarn_reason = "YarnGPT2 weights are not fully cached yet."
    return {
        "ollama_ready": ready,
        "ollama_model": model,
        "ollama_url": base_url,
        "stt_ready": {
            "stt_fw_tiny": whisper_tiny_ready,
            "stt_fw_small": whisper_small_ready,
            "stt_underdog_bark": bark_ready,
        },
        "tts_ready": {"tts_kokoro": kokoro_ready, "tts_yarngpt2": yarn_ready},
        "model_reasons": {"stt_underdog_bark": bark_reason, "tts_yarngpt2": yarn_reason},
        "yarn_voices": yarn_voices,
    }


def _wav_response(pcm_s16le: bytes, sample_rate: int) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm_s16le)
    return output.getvalue()


def _stream_event(event_type: str, **values: Any) -> str:
    return json.dumps({"type": event_type, **values}, ensure_ascii=False) + "\n"


@app.post("/api/turn/stream")
def stream_turn(request: TurnRequest) -> StreamingResponse:
    """Transcribe once, then synthesize/play reply sentences as the LLM emits them."""

    def events():
        audio_path: Path | None = None
        started = time.perf_counter()
        timings: dict[str, float] = {}
        phase = "reading the recording"
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
            phase = f"transcribing with {request.stt_model}"
            transcribe_started = time.perf_counter()
            stt_result = _stt(request.stt_model).transcribe_file(
                str(audio_path), language="en", word_timestamps=False
            )
            timings["transcription_seconds"] = round(
                time.perf_counter() - transcribe_started, 2
            )
            transcript = stt_result.text.strip()
            if not transcript:
                yield _stream_event("error", message="I couldn't make out any speech. Try again.")
                return
            safe_transcript = redact_for_storage(transcript)
            yield _stream_event("transcript", transcript=safe_transcript)

            if (
                request.tts_model == "tts_yarngpt2"
                and request.voice_id not in _authorized_yarn_voices()
            ):
                yield _stream_event(
                    "error",
                    message=(
                        "Choose a YarnGPT2 profile with documented voice authorization."
                    ),
                )
                return
            phase = f"loading {request.tts_model}"
            tts = _tts(request.tts_model)
            language = os.getenv("DEMO_LANGUAGE", "en-NG")
            safe_history = [
                {"role": entry["role"], "content": entry["content"][:2000]}
                for entry in request.history[-10:]
                if entry.get("role") in {"user", "assistant"}
                and isinstance(entry.get("content"), str)
            ]
            try:
                from litellm import completion

                phase = "asking Ollama for a reply"
                llm_started = time.perf_counter()
                response_stream = completion(
                    model=os.getenv("LITELLM_MODEL", "ollama/qwen2.5:3b"),
                    messages=[
                        {"role": "system", "content": SYSTEM_MESSAGE},
                        *safe_history,
                        {"role": "user", "content": safe_transcript},
                    ],
                    api_base=os.getenv("LITELLM_BASE_URL", "http://localhost:11434"),
                    stream=True,
                    temperature=0.2,
                    max_tokens=int(os.getenv("ASSISTANT_MAX_TOKENS", "64")),
                )
                pending_text = ""
                full_reply: list[str] = []
                first_audio = True
                for event in response_stream:
                    delta = event.choices[0].delta
                    content = getattr(delta, "content", None) or ""
                    if not content:
                        continue
                    if "first_token_seconds" not in timings:
                        timings["first_token_seconds"] = round(
                            time.perf_counter() - llm_started, 2
                        )
                    full_reply.append(content)
                    pending_text += content
                    while match := re.search(r"[.!?](?:\s|$)", pending_text):
                        sentence = pending_text[: match.end()].strip()
                        pending_text = pending_text[match.end() :].lstrip()
                        if not sentence:
                            continue
                        safe_sentence = redact_for_storage(sentence)
                        yield _stream_event("text", text=safe_sentence)
                        phase = f"synthesizing with {request.tts_model}"
                        speech_started = time.perf_counter()
                        audio = tts.synthesize(
                            safe_sentence, voice_id=request.voice_id, language=language
                        )
                        timings["speech_seconds"] = round(
                            timings.get("speech_seconds", 0.0)
                            + time.perf_counter()
                            - speech_started,
                            2,
                        )
                        if first_audio:
                            timings["first_audio_seconds"] = round(
                                time.perf_counter() - started, 2
                            )
                            first_audio = False
                        yield _stream_event(
                            "audio",
                            audio_wav_base64=base64.b64encode(
                                _wav_response(audio.pcm_s16le, audio.sample_rate)
                            ).decode("ascii"),
                        )
                        phase = "asking Ollama for a reply"
                tail = pending_text.strip()
                if tail:
                    safe_tail = redact_for_storage(tail)
                    yield _stream_event("text", text=safe_tail)
                    phase = f"synthesizing with {request.tts_model}"
                    speech_started = time.perf_counter()
                    audio = tts.synthesize(
                        safe_tail, voice_id=request.voice_id, language=language
                    )
                    timings["speech_seconds"] = round(
                        timings.get("speech_seconds", 0.0)
                        + time.perf_counter()
                        - speech_started,
                        2,
                    )
                    if first_audio:
                        timings["first_audio_seconds"] = round(
                            time.perf_counter() - started, 2
                        )
                    yield _stream_event(
                        "audio",
                        audio_wav_base64=base64.b64encode(
                            _wav_response(audio.pcm_s16le, audio.sample_rate)
                        ).decode("ascii"),
                    )
                reply = "".join(full_reply).strip()
                timings["assistant_seconds"] = round(time.perf_counter() - llm_started, 2)
                yield _stream_event(
                    "done",
                    reply=redact_for_storage(reply),
                    timings=timings,
                )
            except Exception as error:
                logger.exception("Voice turn failed while %s", phase)
                if phase == "asking Ollama for a reply":
                    message = (
                        f"Ollama could not finish the reply ({type(error).__name__}). "
                        "Check that Ollama is running and its configured model is loaded."
                    )
                elif request.tts_model == "tts_yarngpt2":
                    message = (
                        f"YarnGPT2 couldn't synthesize this reply ({type(error).__name__}). "
                        "Try a shorter reply, another authorized voice, or Kokoro."
                    )
                else:
                    message = (
                        f"Kokoro couldn't synthesize this reply ({type(error).__name__}). "
                        "Check that its local voice assets are available."
                    )
                yield _stream_event(
                    "error",
                    message=message,
                )
        except (ValueError, wave.Error, base64.binascii.Error) as error:
            yield _stream_event("error", message=f"Invalid recording: {error}")
        except Exception as error:
            logger.exception("Voice turn failed while %s", phase)
            yield _stream_event(
                "error",
                message=(
                    f"There was a problem {phase} "
                    f"({type(error).__name__}: {str(error)[:180]})."
                ),
            )
        finally:
            if audio_path is not None:
                audio_path.unlink(missing_ok=True)

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/turn")
def turn(request: TurnRequest) -> dict[str, Any]:
    phase = "reading the recording"
    timings: dict[str, float] = {}
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
            phase = f"loading {request.stt_model}"
            stt = _stt(request.stt_model)
            phase = f"transcribing with {request.stt_model}"
            started = time.perf_counter()
            stt_result = stt.transcribe_file(
                str(audio_path), language="en", word_timestamps=False
            )
            timings["transcription_seconds"] = round(time.perf_counter() - started, 2)
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
            started = time.perf_counter()
            reply, _, _ = _llm_reply(
                safe_transcript,
                safe_history,
                model=os.getenv("LITELLM_MODEL", "ollama/qwen2.5:3b"),
                first_token_callback=lambda _: None,
            )
            timings["assistant_seconds"] = round(time.perf_counter() - started, 2)
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
        phase = f"loading {request.tts_model}"
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
        phase = f"synthesizing with {request.tts_model}"
        started = time.perf_counter()
        audio = tts.synthesize(reply, voice_id=request.voice_id, language=language)
        timings["speech_seconds"] = round(time.perf_counter() - started, 2)
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
            "timings": timings,
        }
    except HTTPException:
        raise
    except (ValueError, wave.Error, base64.binascii.Error) as error:
        raise HTTPException(status_code=400, detail=f"Invalid recording: {error}") from error
    except Exception as error:
        logger.exception("Voice turn failed while %s", phase)
        raise HTTPException(
            status_code=500,
            detail=(
                f"There was a problem {phase} "
                f"({type(error).__name__}: {str(error)[:240]})."
            ),
        ) from error
