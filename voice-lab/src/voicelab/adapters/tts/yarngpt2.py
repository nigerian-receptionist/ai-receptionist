"""Local YarnGPT2 text-to-speech generator backed by the WavTokenizer adapter."""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import numpy as np

from voicelab.adapters.codec.wavtokenizer import WavTokenizerCodecAdapter
from voicelab.interfaces import AudioChunk, TtsResult, VoiceInfo


class YarnGPT2Adapter:
    """Generate English Nigerian-accented speech from local consented profiles.

    The model generates WavTokenizer code tokens; the codec adapter renders them
    to 24 kHz audio. No upstream preset speaker profiles are bundled or loaded.
    """

    model_id = "tts_yarngpt2"
    sample_rate_hz = 24000

    def __init__(
        self,
        *,
        codec: WavTokenizerCodecAdapter | None = None,
        model_id: str = "saheedniyi/YarnGPT2",
        revision: str,
        speakers_dir: str | Path | None = None,
        device: str | None = None,
        local_files_only: bool = False,
        max_new_tokens: int = 1200,
    ) -> None:
        if not revision:
            raise ValueError("Set YARNGPT2_REVISION to an immutable Hugging Face commit")
        if max_new_tokens < 1:
            raise ValueError("max_new_tokens must be positive")
        try:
            import inflect
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
        except ImportError as error:
            raise RuntimeError(
                "Install the optional `yarngpt2` and `codec` dependency groups"
            ) from error

        self._torch = torch
        self._number_engine = inflect.engine()
        self._device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self._tokenizer = AutoTokenizer.from_pretrained(
            model_id, revision=revision, local_files_only=local_files_only
        )
        self._model = AutoModelForCausalLM.from_pretrained(
            model_id, revision=revision, local_files_only=local_files_only, torch_dtype="auto"
        ).to(self._device).eval()
        self.model_revision = revision
        self._max_new_tokens = max_new_tokens
        self._speakers_dir = Path(
            speakers_dir or os.getenv("YARNGPT2_SPEAKERS_DIR", "models/yarngpt2/speakers")
        ).expanduser()
        self._codec = codec or WavTokenizerCodecAdapter.from_environment()

    @classmethod
    def from_environment(cls) -> YarnGPT2Adapter:
        revision = os.getenv("YARNGPT2_REVISION")
        if not revision:
            raise RuntimeError(
                "Set YARNGPT2_REVISION to a reviewed immutable model commit; "
                "the verified model card currently shows bf654c7"
            )
        return cls(
            model_id=os.getenv("YARNGPT2_MODEL", "saheedniyi/YarnGPT2"),
            revision=revision,
            speakers_dir=os.getenv("YARNGPT2_SPEAKERS_DIR"),
            device=os.getenv("YARNGPT2_DEVICE"),
            local_files_only=os.getenv("YARNGPT2_LOCAL_FILES_ONLY", "false").lower()
            in {"1", "true", "yes"},
            max_new_tokens=int(os.getenv("YARNGPT2_MAX_NEW_TOKENS", "1200")),
        )

    def _load_profile(self, voice_id: str) -> dict[str, Any]:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", voice_id):
            raise ValueError("voice_id may contain only letters, digits, '_' and '-'")
        path = self._speakers_dir / f"{voice_id}.json"
        if not path.is_file():
            raise FileNotFoundError(
                f"No local YarnGPT2 speaker profile at {path}; create one from a voice "
                "whose owner has documented permission for AI speech generation"
            )
        profile = json.loads(path.read_text(encoding="utf-8"))
        if profile.get("voice_use_authorized") is not True or not profile.get("consent_id"):
            raise PermissionError(
                f"Speaker profile {voice_id} must include voice_use_authorized: true "
                "and a consent_id for its documented permission record"
            )
        if not isinstance(profile.get("text"), str) or not profile["text"].strip():
            raise ValueError(f"Speaker profile {voice_id} needs a non-empty 'text' prompt")
        words = profile.get("words")
        if not isinstance(words, list) or not words:
            raise ValueError(f"Speaker profile {voice_id} needs non-empty aligned 'words'")
        for entry in words:
            if (
                not isinstance(entry, dict)
                or not isinstance(entry.get("word"), str)
                or not isinstance(entry.get("codes"), list)
                or not entry["codes"]
            ):
                raise ValueError(f"Speaker profile {voice_id} has an invalid word/code entry")
        return profile

    def voices(self) -> list[VoiceInfo]:
        if not self._speakers_dir.is_dir():
            return []
        voices = []
        for path in sorted(self._speakers_dir.glob("*.json")):
            try:
                profile = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if profile.get("voice_use_authorized") is True and profile.get("consent_id"):
                voices.append(VoiceInfo(voice_id=path.stem, language="en-NG"))
        return voices

    def _prompt_text(self, text: str) -> str:
        # Keep the English prompt normalization used by upstream's tokenizer.
        normalized = re.sub(
            r"\d+(?:\.\d+)?",
            lambda match: self._number_engine.number_to_words(match.group()),
            text.lower(),
        ).replace("-", " ").replace("_", " ")
        normalized = re.sub(r"[^a-z\s]", " ", normalized)
        return " ".join(normalized.split())

    def _make_prompt(self, text: str, profile: dict[str, Any]) -> str:
        words = f"<|text_sep|>".join(
            word for word in (self._prompt_text(profile["text"]), self._prompt_text(text)) if word
        )
        prompt = f"<|im_start|>\n<|text_start|>{words}<|text_end|>\n<|english|>\n<|audio_start|>\n"
        for entry in profile["words"]:
            duration = float(entry.get("duration", 0.0))
            codes = entry["codes"]
            if duration < 0 or any(not isinstance(code, int) or code < 0 for code in codes):
                raise ValueError("Speaker profile duration and codes must be non-negative numbers")
            code_text = "".join(f"<|{code}|>" for code in codes)
            prompt += f"{entry['word']}<|t_{duration:.2f}|><|code_start|>{code_text}<|code_end|>\n"
        return prompt

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str,
        language: str,
        tone: str = "neutral",
        speed: float = 1.0,
    ) -> TtsResult:
        del tone
        if language not in {"en", "en-NG", "en-US", "english"}:
            raise ValueError("YarnGPT2 adapter currently supports English only")
        if speed != 1.0:
            raise ValueError("YarnGPT2 does not expose a speech speed control")
        if not text.strip():
            raise ValueError("text must not be empty")

        profile = self._load_profile(voice_id)
        tokenized = self._tokenizer(
            self._make_prompt(text, profile), add_special_tokens=False, return_tensors="pt"
        )
        input_ids = tokenized["input_ids"].to(self._device)
        attention_mask = tokenized["attention_mask"].to(self._device)
        started = time.perf_counter()
        with self._torch.inference_mode():
            generated = self._model.generate(
                input_ids=input_ids,
                attention_mask=attention_mask,
                temperature=0.1,
                repetition_penalty=1.1,
                do_sample=True,
                max_new_tokens=self._max_new_tokens,
                pad_token_id=self._tokenizer.eos_token_id,
            )
        generated_text = self._tokenizer.decode(
            generated[0, input_ids.shape[1] :], skip_special_tokens=False
        )
        codes = [int(code) for code in re.findall(r"\|(-?\d+)\|", generated_text)]
        if not codes:
            raise RuntimeError("YarnGPT2 generated no WavTokenizer audio codes")
        if any(code < 0 or code > 4095 for code in codes):
            raise RuntimeError("YarnGPT2 returned an audio code outside WavTokenizer's codebook")
        # Upstream YarnGPT2 emits a flat sequence for the single active codebook.
        samples = self._codec.decode([codes]).detach().cpu().numpy().astype(np.float32).reshape(-1)
        latency = time.perf_counter() - started
        pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        return TtsResult(
            pcm_s16le=pcm,
            sample_rate=self.sample_rate_hz,
            duration_s=len(samples) / self.sample_rate_hz,
            time_to_first_audio_s=latency,
            total_latency_s=latency,
            voice_id=voice_id,
            model_id=self.model_id,
            text_spoken=text,
        )

    async def synthesize_stream(
        self,
        text: str,
        *,
        voice_id: str,
        language: str,
        tone: str = "neutral",
        speed: float = 1.0,
    ) -> AsyncIterator[AudioChunk]:
        """Emulate sentence streaming; each generated sentence is a full model call."""
        sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
        for index, sentence in enumerate(sentences):
            result = self.synthesize(
                sentence,
                voice_id=voice_id,
                language=language,
                tone=tone,
                speed=speed,
            )
            yield AudioChunk(
                pcm_s16le=result.pcm_s16le,
                sample_rate=result.sample_rate,
                is_first=index == 0,
                is_last=index == len(sentences) - 1,
            )
