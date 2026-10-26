# Voice-lab license review

This records the upstream license evidence checked on 2026-10-26. A permissive
model-card license does not clear training-data provenance, voice likeness,
distribution, or local commercial-use obligations. The license in the exact
artifact revision must be checked again before adoption. Candidate models marked
blocked are not loaded by the registry.

| Candidate | Code / weights | Status | Evidence / reason |
|---|---|---|---|
| OpenAI Whisper | MIT runtime; official Whisper weights MIT | Cleared for local evaluation | [Upstream code and model hashes](https://github.com/openai/whisper), [model card](https://github.com/openai/whisper/blob/main/model-card.md) |
| faster-whisper | MIT library; same Whisper model family | Not used in this lab | Its PyAV 19 dependency is incompatible with faster-whisper 1.2.1; PyAV binary-wheel licensing also needs review under AGENTS section 19. See the [upstream compatibility issue](https://github.com/SYSTRAN/faster-whisper/issues/1589) and [PyAV wheel license discussion](https://github.com/PyAV-Org/PyAV/issues/2270). |
| N-ATLaS ASR | Custom Open-Source Research and Innovation License; not OSI open source; commercial or large-scale use requires separate agreement | Blocked | [Official NCAIR1 model card](https://huggingface.co/NCAIR1/N-ATLaS) states its terms; conflicts with permissive-only adoption policy |
| Community Whisper multilingual | Reported Apache-2.0, but exact repo artifact and provenance not verified | Blocked | Verify the selected repository's current model card, exact revision, and data rights first |
| NVIDIA Parakeet TDT 0.6B v3 | CC-BY-4.0 model weights | Blocked pending attribution review | [Official NVIDIA model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3); section 19 requires review before CC-BY use |
| sherpa-onnx / Vosk | Runtime source license does not determine each model's weights license | Blocked | Select and review exact model artifacts before downloading |
| YarnGPT2 | Hugging Face model card identifies Apache-2.0; its base SmolLM2 is Apache-2.0. The project's own WavTokenizer artifact and helper code need separate review. | Blocked | [YarnGPT2 model card](https://huggingface.co/saheedniyi/YarnGPT2) documents experimental use and English Nigerian accent; training sources include public media. Preset speaker provenance and rights are unresolved. |
| Orpheus | Exact weights and base-model terms not verified | Blocked | Verify exact checkpoint and full license chain |
| Chatterbox | Exact weight revision, voice source, and reference-voice terms not verified | Blocked | Verify before use; no voice cloning in this benchmark |
| Kokoro-82M | Apache-2.0 weights; MIT kokoro-onnx runtime plus GPL phonemizer 3.4.0 and eSpeak NG via espeakng-loader 0.2.4 | Approved for this lab after human approval for commercial use; follow GPL obligations before distribution. The voice is only an English comparison, not a Nigerian-accent baseline. | [Kokoro model card](https://huggingface.co/hexgrad/Kokoro-82M), [runtime dependency metadata](https://simple-repository.app.cern.ch/project/kokoro-onnx), [phonemizer](https://github.com/bootphon/phonemizer), [eSpeak NG](https://github.com/espeak-ng/espeak-ng) |
| Piper | License varies by voice and version | Blocked | Review the exact voice artifact and runtime version |
| Own fine-tunes | Dependent on base model and training-data / voice-talent licenses | Blocked | No consented training dataset or signed voice-talent license is available |

No model weights are stored in Git. `models.yaml` prevents blocked candidates
from being selected by the benchmark adapters.
