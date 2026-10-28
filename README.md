# ai-receptionist

The current active focus is the local speech and conversation demo in
`voice-lab/`.

## Voice Lab

The interactive local voice demo lives in `voice-lab/`. Start it from that
directory:

```sh
cd voice-lab
uv run python scripts/web_demo.py
```

Then open [http://127.0.0.1:8765/](http://127.0.0.1:8765/). Keep the server
running while you use the page; stop it with Ctrl+C. Do **not** open
`voice-lab/web/index.html` directly as a `file://` URL. The browser page needs
the local server for `/api/status` and `/api/turn/stream`; opening the file
directly causes “Failed to fetch.”

Whisper Tiny and Kokoro are the faster CPU options. Bark and YarnGPT2 are
available for local evaluation but can take longer on CPU. See
[voice-lab/README.md](voice-lab/README.md) for model setup and troubleshooting.
