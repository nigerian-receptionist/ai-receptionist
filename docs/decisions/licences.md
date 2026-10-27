# Speech component license review

Checked 2026-10-26. Record exact model revisions and hashes with every run.
Model license metadata alone does not clear training data, voice likeness, or
speaker consent.

| Component | Version / candidate | License | Commercial-use status and notes | Evidence |
|---|---|---|---|---|
| OpenAI Whisper | 20250625 | MIT | Allowed local runtime; uses system FFmpeg to decode audio | [Upstream license](https://github.com/openai/whisper/blob/main/LICENSE) |
| Underdog Bark 3.0 | ConwayResearch/Underdog-Bark-3.0 at `85db2ad` | CC-BY-4.0 | Local English speech recognition only; attribute NVIDIA, Moondream and Conway Research per the model repository's NOTICE. | [Official model card](https://huggingface.co/ConwayResearch/Underdog-Bark-3.0) |
| WavTokenizer source | Official upstream repository | MIT | Codec adapter only; local source revision must be pinned before benchmark | [Upstream license](https://github.com/jishengpeng/WavTokenizer/blob/main/LICENSE) |
| WavTokenizer checkpoint | Official `novateur/WavTokenizer` model card | MIT | No exact checkpoint selected yet; pin repository revision and file hash before use | [Official model repository](https://huggingface.co/novateur/WavTokenizer) |
| torchaudio | Optional codec runtime | BSD | Allowed; CPU wheel is resolved from the PyTorch CPU index | [Upstream setup metadata](https://github.com/pytorch/audio/blob/main/setup.py) |
| einops | Optional codec runtime | MIT | Allowed | [Upstream license](https://github.com/arogozhnikov/einops/blob/main/LICENSE) |
| SciPy | Optional WavTokenizer runtime | BSD-3-Clause | Allowed; required by upstream spectral operations | [Upstream license](https://github.com/scipy/scipy/blob/main/LICENSE.txt) |
| Whisper large-v3-turbo | Official checkpoint SHA `aff26ae4…` | MIT | Allowed for local evaluation; SHA pinned in model config | [Official code and checkpoint hash](https://github.com/openai/whisper/blob/main/whisper/__init__.py) |
| Whisper large-v3 | Official checkpoint SHA `e5b1a55b…` | MIT | Allowed for local evaluation; SHA pinned in model config | [Official code and checkpoint hash](https://github.com/openai/whisper/blob/main/whisper/__init__.py) |
| Whisper small | Official checkpoint SHA `9ecf7799…` | MIT | Allowed for local evaluation; SHA pinned in model config | [Official code and checkpoint hash](https://github.com/openai/whisper/blob/main/whisper/__init__.py) |
| faster-whisper | 1.2.1 | MIT library | Not adopted: dependency resolved PyAV 19, whose API breaks this release; PyAV wheel license needs review under section 19 | [Runtime issue](https://github.com/SYSTRAN/faster-whisper/issues/1589), [PyAV wheel license discussion](https://github.com/PyAV-Org/PyAV/issues/2270) |
| jiwer | 4.0.0 | Apache-2.0 | Allowed | [Upstream source](https://github.com/jitsi/jiwer) |
| NumPy | 2.5.4 | BSD-3-Clause plus bundled license notices | Allowed | [Upstream license details](https://github.com/numpy/numpy/blob/main/pyproject.toml) |
| PyYAML | 6.0.3 | MIT | Allowed | [Upstream license](https://github.com/yaml/pyyaml/blob/main/LICENSE) |
| Kokoro-82M | Official model | Apache-2.0 | Comparison only; voice set is not a Nigerian-accent baseline | [Model card](https://huggingface.co/hexgrad/Kokoro-82M) |
| kokoro-onnx | 0.6.1 | MIT | Comparison runtime; imports GPL phonemizer and eSpeak NG at runtime. Human approval for commercial use recorded in ADR 0003; comply with GPL distribution/source obligations before distributing the combined environment or application. | [Upstream license](https://github.com/thewh1teagle/kokoro-onnx/blob/main/LICENSE), [dependency metadata](https://simple-repository.app.cern.ch/project/kokoro-onnx) |
| phonemizer | 3.4.0 | GPL-3.0-or-later | Human approved commercial use for this lab in ADR 0003; GPL obligations apply | [Upstream project](https://github.com/bootphon/phonemizer) |
| espeakng-loader | 0.2.4 | Bundles eSpeak NG; GPL-3.0-or-later | Human approved commercial use for this lab in ADR 0003; GPL obligations apply | [eSpeak NG license](https://github.com/espeak-ng/espeak-ng) |
| ONNX Runtime | 1.31.0 | MIT | Allowed as a local inference runtime | [Upstream license](https://github.com/microsoft/onnxruntime) |
| LiteLLM | 1.106.4 | MIT outside `enterprise/` | Allowed for the local LLM demo; no speech API used | [Upstream license](https://github.com/BerriAI/litellm/blob/main/LICENSE) |
| Silero VAD | 6.2.3 | MIT | Allowed for local voice activity detection | [Upstream project](https://github.com/snakers4/silero-vad) |
| sounddevice | 0.5.6 | MIT | Allowed; the bundled PortAudio library has its own permissive license notice | [Upstream project](https://github.com/spatialaudio/python-sounddevice) |
| PyTorch | 2.14.1 CPU wheel | BSD-3-Clause | Allowed as Silero VAD's runtime dependency; the lock pins the CPU-only wheel and excludes CUDA packages | [Upstream license](https://github.com/pytorch/pytorch/blob/main/LICENSE), [CPU wheel index](https://download.pytorch.org/whl/cpu) |
| N-ATLaS | NCAIR1 gated models | Custom research and innovation terms | Blocked; not OSI open source and commercial use needs separate agreement | [Model card](https://huggingface.co/NCAIR1/N-ATLaS) |
| NVIDIA Parakeet TDT 0.6B v3 | Official model | CC-BY-4.0 | Blocked pending required attribution review | [Model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) |
| YarnGPT2 | `saheedniyi/YarnGPT2` | Apache-2.0 model card; MIT upstream helper | Local experimental evaluation only; commercial deployment pending review of public-media training provenance. Runtime requires a private profile with documented speaker consent. | [Model card](https://huggingface.co/saheedniyi/YarnGPT2), [helper repository](https://github.com/saheedniyi02/yarngpt) |
| Orpheus / Chatterbox / Piper / Vosk / sherpa models | Exact artifacts not selected | Unknown or artifact-specific | Blocked until exact weights, runtime, and provenance are reviewed | See candidate notes in [`../../voice-lab/licences.md`](../../voice-lab/licences.md) |

The direct live-demo libraries are license-checked. Run an automated license
scan over all transitive locked dependencies before production adoption.
LGPL or other section-19 ask-first packages must not be introduced without an
ADR.
