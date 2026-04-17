"""
Real-time transcription bridge for camera.js.

Uses RealtimeSTT to listen on the default microphone and emit JSON-line events
to stdout. camera.js spawns this as a child process and forwards each event
to the canvas overlay.

Output protocol (one JSON object per line):
  {"type": "ready"}                          — model loaded, listening
  {"type": "partial", "text": "..."}         — live in-progress text (changes fast)
  {"type": "final",   "text": "..."}         — finalized sentence
  {"type": "error",   "message": "..."}      — fatal startup error

Run directly to test:
    .venv/bin/python transcribe.py
Speak into your mic and you should see JSON appear.
"""

import json
import os
import sys
import warnings

# Silence the noisy startup logging from faster-whisper, ctranslate2, etc.
# We want a clean stdout protocol — only our JSON events, nothing else.
warnings.filterwarnings("ignore")
os.environ.setdefault("CT2_VERBOSE", "0")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("PYTHONWARNINGS", "ignore")


def emit(obj):
    """Write a single JSON line to stdout and flush immediately."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    try:
        # Redirect stderr to /dev/null while importing — RealtimeSTT and its
        # dependencies print a lot of progress/warning chatter on import that
        # would otherwise pollute the parent process's view of stderr.
        devnull = open(os.devnull, "w")
        old_stderr = sys.stderr
        sys.stderr = devnull
        try:
            from RealtimeSTT import AudioToTextRecorder
        finally:
            sys.stderr = old_stderr
    except Exception as e:
        emit({"type": "error", "message": f"import failed: {e}"})
        return

    def on_partial(text):
        # Fires many times per second while the user is speaking.
        if text:
            emit({"type": "partial", "text": text})

    try:
        recorder = AudioToTextRecorder(
            # 'tiny' is fastest. 'base' or 'small' for higher quality.
            model="tiny.en",
            # The realtime (partial) model is separate from the final model.
            # Using tiny for partials keeps live updates fast.
            realtime_model_type="tiny.en",
            language="en",
            enable_realtime_transcription=True,
            on_realtime_transcription_update=on_partial,
            # Don't print library status updates — we have our own protocol.
            spinner=False,
            level=50,  # logging.CRITICAL
            # Run on CPU. MPS support is iffy on faster-whisper for older
            # macOS / torch combos; CPU is the safe default for tiny.en.
            device="cpu",
        )
    except Exception as e:
        emit({"type": "error", "message": f"recorder init failed: {e}"})
        return

    emit({"type": "ready"})

    def on_final(text):
        if text:
            emit({"type": "final", "text": text})

    try:
        # recorder.text(callback) blocks and calls callback every time a
        # complete sentence is finalized. Loop forever.
        while True:
            recorder.text(on_final)
    except KeyboardInterrupt:
        pass
    except Exception as e:
        emit({"type": "error", "message": f"recorder loop failed: {e}"})


if __name__ == "__main__":
    main()
