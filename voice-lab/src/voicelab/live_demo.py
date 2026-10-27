"""Microphone echo demo with in-memory audio and optional local LiteLLM response."""

from __future__ import annotations

import json
import os
import tempfile
import time
import wave
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from voicelab.model_registry import create_stt_adapter, create_tts_adapter
from voicelab.privacy import redact_for_storage
from voicelab.run_metadata import create_run_id

SAMPLE_RATE = 16000
BLOCK_SIZE = 512
SILENCE_SECONDS = 0.6
SYSTEM_MESSAGE = (
    "You are a concise voice demo. Be warm and respectful. Do not claim to be human. "
    "Do not give medical, legal, or financial advice. If asked for a human, "
    "say this is a local demo. Keep spoken replies conversational and usually under "
    "35 words unless the user asks for detail."
)
OPENING = (
    "Hello. I am an AI assistant in a local microphone demo, not a person. "
    "This is not a real call. Your microphone audio is processed in memory and is not saved."
)


def _speak(text: str, tts, voice: str, language: str) -> None:
    import sounddevice as sd

    result = tts.synthesize(text, voice_id=voice, language=language)
    samples = np.frombuffer(result.pcm_s16le, dtype="<i2")
    sd.play(samples, result.sample_rate, blocking=True)


def _capture_turn(vad_model, stream, *, threshold: float, max_seconds: float) -> np.ndarray:
    import torch

    pieces: list[np.ndarray] = []
    speech_started = False
    silence_samples = 0
    max_blocks = int(max_seconds * SAMPLE_RATE / BLOCK_SIZE)
    for _ in range(max_blocks):
        block, overflowed = stream.read(BLOCK_SIZE)
        if overflowed:
            continue
        mono = block.reshape(-1)
        probability = float(
            vad_model(torch.from_numpy(mono.astype(np.float32) / 32768), SAMPLE_RATE)
        )
        if probability >= threshold:
            speech_started = True
            silence_samples = 0
            pieces.append(mono.copy())
        elif speech_started:
            pieces.append(mono.copy())
            silence_samples += len(mono)
            if silence_samples >= int(SILENCE_SECONDS * SAMPLE_RATE):
                break
    if not pieces:
        return np.array([], dtype=np.int16)
    return np.concatenate(pieces)


def _llm_reply(
    transcript: str,
    history: list[dict[str, str]],
    *,
    model: str,
    first_token_callback: Callable[[float], None],
) -> tuple[str, float, float]:
    try:
        from litellm import completion
    except ImportError as error:
        raise RuntimeError("Install the `live` dependency group to use the LLM loop") from error

    base_url = os.getenv("LITELLM_BASE_URL", "http://localhost:11434")
    messages = [{"role": "system", "content": SYSTEM_MESSAGE}, *history]
    messages.append({"role": "user", "content": redact_for_storage(transcript)})
    started = time.perf_counter()
    response_stream = completion(
        model=model,
        messages=messages,
        api_base=base_url,
        stream=True,
        temperature=0.2,
        max_tokens=120,
    )
    fragments: list[str] = []
    first_token: float | None = None
    for event in response_stream:
        delta = event.choices[0].delta
        content = getattr(delta, "content", None) or ""
        if content and first_token is None:
            first_token = time.perf_counter() - started
            first_token_callback(first_token)
        if content:
            fragments.append(content)
    done = time.perf_counter() - started
    return "".join(fragments).strip(), first_token if first_token is not None else done, done


def _spoken_prefix(text: str, fraction: float) -> str:
    words = text.split()
    count = max(0, min(len(words), round(len(words) * fraction)))
    return " ".join(words[:count])


def run_echo_loop(
    *,
    include_llm: bool,
    max_seconds: float = 12.0,
    barge_in: bool = True,
    tts_model: str | None = None,
    stt_model: str = "stt_fw_small",
) -> None:
    try:
        import sounddevice as sd
        import torch
        from silero_vad import load_silero_vad
    except ImportError as error:
        raise RuntimeError(
            "Install the `live` dependency group to use the microphone demo"
        ) from error

    stt = create_stt_adapter(stt_model)
    tts_model = tts_model or os.getenv("TTS_MODEL", "tts_kokoro")
    tts = create_tts_adapter(tts_model)
    voice = os.getenv("TTS_VOICE", "")
    if not voice and tts_model == "tts_yarngpt2":
        raise RuntimeError("Set TTS_VOICE to an authorized local YarnGPT2 speaker profile")
    if not voice:
        voice = "af_sarah"
    language = os.getenv("DEMO_LANGUAGE", "en-NG")
    llm_model = os.getenv("LITELLM_MODEL", "ollama/qwen2.5:3b")
    vad = load_silero_vad()
    _speak(OPENING, tts, voice, language)
    history: list[dict[str, str]] = []
    run_id = create_run_id()
    log_path = Path("results/raw") / f"echo_{run_id}.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    print("Local demo ready. Audio is processed in memory; Ctrl-C ends the session.")
    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=BLOCK_SIZE,
        ) as microphone:
            while True:
                turn_started = time.perf_counter()
                print("Listening…")
                user_audio = _capture_turn(vad, microphone, threshold=0.55, max_seconds=max_seconds)
                if user_audio.size == 0:
                    continue
                speech_end = time.perf_counter()
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as audio_file:
                    audio_path = Path(audio_file.name)
                try:
                    with wave.open(str(audio_path), "wb") as audio_writer:
                        audio_writer.setnchannels(1)
                        audio_writer.setsampwidth(2)
                        audio_writer.setframerate(SAMPLE_RATE)
                        audio_writer.writeframes(user_audio.astype("<i2").tobytes())
                    stt_result = stt.transcribe_file(str(audio_path))
                finally:
                    audio_path.unlink(missing_ok=True)
                stt_final = time.perf_counter()
                transcript = stt_result.text.strip()
                if not transcript:
                    continue
                print(f"You: {redact_for_storage(transcript)}")
                llm_first_token: float | None = None
                llm_done: float | None = None
                if include_llm:
                    try:
                        reply, llm_first_token, llm_done = _llm_reply(
                            transcript,
                            history,
                            model=llm_model,
                            first_token_callback=lambda _: None,
                        )
                    except Exception as error:
                        reply = (
                            "I am having trouble right now. A human can help with the next step."
                        )
                        print(
                            f"LLM unavailable ({type(error).__name__}); "
                            "using a safe local fallback."
                        )
                else:
                    reply = (
                        f"I heard you say: {redact_for_storage(transcript)}. "
                        "What would you like to add?"
                    )
                if not reply:
                    reply = "I did not get a response. Please try once more."
                print(f"Assistant: {redact_for_storage(reply)}")
                tts_result = tts.synthesize(reply, voice_id=voice, language=language)
                tts_first_audio = time.perf_counter()
                play_start = time.perf_counter()
                samples = np.frombuffer(tts_result.pcm_s16le, dtype="<i2")
                sd.play(samples, tts_result.sample_rate, blocking=False)
                interrupted_audio = np.array([], dtype=np.int16)
                interrupted = False
                silence_samples = 0
                if barge_in:
                    while sd.get_stream().active or (
                        interrupted and silence_samples < int(SILENCE_SECONDS * SAMPLE_RATE)
                    ):
                        block, overflowed = microphone.read(BLOCK_SIZE)
                        if overflowed:
                            continue
                        mono = block.reshape(-1)
                        score = float(
                            vad(torch.from_numpy(mono.astype(np.float32) / 32768), SAMPLE_RATE)
                        )
                        if score >= 0.65:
                            interrupted = True
                            interrupted_audio = np.append(interrupted_audio, mono)
                            silence_samples = 0
                            sd.stop()
                        elif interrupted:
                            interrupted_audio = np.append(interrupted_audio, mono)
                            silence_samples += len(mono)
                else:
                    sd.wait()
                played_s = time.perf_counter() - play_start
                duration_s = len(samples) / tts_result.sample_rate
                fraction_played = min(1.0, played_s / duration_s) if duration_s else 0.0
                spoken_reply = _spoken_prefix(reply, fraction_played) if interrupted else reply
                safe_user_text = redact_for_storage(transcript)
                history.extend(
                    [
                        {"role": "user", "content": safe_user_text},
                        {"role": "assistant", "content": spoken_reply},
                    ]
                )
                if interrupted and interrupted_audio.size:
                    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as audio_file:
                        interrupted_path = Path(audio_file.name)
                    try:
                        with wave.open(str(interrupted_path), "wb") as audio_writer:
                            audio_writer.setnchannels(1)
                            audio_writer.setsampwidth(2)
                            audio_writer.setframerate(SAMPLE_RATE)
                            audio_writer.writeframes(interrupted_audio.astype("<i2").tobytes())
                        interrupt_result = stt.transcribe_file(str(interrupted_path))
                    finally:
                        interrupted_path.unlink(missing_ok=True)
                    interrupt_text = redact_for_storage(interrupt_result.text.strip())
                    if interrupt_text:
                        history.append({"role": "user", "content": interrupt_text})
                timings = {
                    "t_speech_end": speech_end - turn_started,
                    "t_stt_final": stt_final - turn_started,
                    "t_llm_first_token": llm_first_token,
                    "t_llm_done": llm_done,
                    "t_tts_first_audio": tts_first_audio - turn_started,
                    "t_playout_start": play_start - turn_started,
                    "end_speech_to_playout_s": play_start - speech_end,
                    "interrupted": interrupted,
                    "played_fraction": fraction_played,
                }
                entry = {
                    "timestamp_utc": datetime.now(UTC).isoformat(),
                    "run_id": run_id,
                    "transcript_redacted": safe_user_text,
                    "reply_spoken": redact_for_storage(spoken_reply),
                    "timings": timings,
                }
                with log_path.open("a", encoding="utf-8") as log:
                    log.write(json.dumps(entry, ensure_ascii=False) + "\n")
                print(
                    "Turn timing: "
                    f"speech_end={timings['t_speech_end']:.2f}s, "
                    f"stt={timings['t_stt_final'] - timings['t_speech_end']:.2f}s, "
                    f"llm={llm_done if llm_done is not None else 0:.2f}s, "
                    f"tts={tts_result.total_latency_s:.2f}s, "
                    f"end-to-playout={timings['end_speech_to_playout_s']:.2f}s"
                )
                vad.reset_states()
                del interrupted_audio
    except KeyboardInterrupt:
        print(f"Demo stopped. Redacted timing log: {log_path}")
