"""Writes down what was said in a session's voice recordings, on this computer, when speech-to-text missed it.

Run with the Whisper set-up in tools/whisper-venv (see AGENT_LOOP.md):
    tools/whisper-venv/Scripts/python agent-tools/transcribe.py sessions/<name> [--from 4:30] [--to 11:00]

Writes sessions/<name>/transcript-recordings.md: every recording, line by line, at session time, under the name
of the person whose microphone made it. In a team session each microphone can pick up the other person too, so
the same words may appear under both names. The recordings never leave this computer; only this text is read.
The Whisper model (small.en, about 500 MB) downloads once, the first time.
"""
import argparse
import json
import sys
from pathlib import Path

import av
import numpy as np
from faster_whisper import WhisperModel


def load_audio(path):
    """The recording as 16 kHz mono sound, which is what Whisper listens to."""
    out = []
    with av.open(str(path)) as box:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in box.decode(audio=0):
            for f in resampler.resample(frame):
                out.append(f.to_ndarray().reshape(-1))
        for f in resampler.resample(None):
            out.append(f.to_ndarray().reshape(-1))
    return np.concatenate(out).astype(np.float32) / 32768.0 if out else np.zeros(0, np.float32)


def clock(ms):
    s = int(ms // 1000)
    return f"{s // 60:02d}:{s % 60:02d}"


def parse_clock(text):
    m, s = text.split(":")
    return (int(m) * 60 + float(s)) * 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    ap.add_argument("--from", dest="start", default=None, help="only from this session time, m:ss")
    ap.add_argument("--to", dest="end", default=None, help="only up to this session time, m:ss")
    ap.add_argument("--model", default="small.en")
    a = ap.parse_args()
    folder = Path(a.session)
    doc = json.loads((folder / "session.json").read_text(encoding="utf-8"))
    start = parse_clock(a.start) if a.start else 0
    end = parse_clock(a.end) if a.end else float("inf")
    model = WhisperModel(a.model, device="cpu", compute_type="int8")
    lines = []
    for rec in doc.get("audio", []):
        f = folder / (rec.get("file") or "")
        if not rec.get("file") or not f.is_file():
            continue
        who = rec.get("by") or "Host"
        segments, _ = model.transcribe(load_audio(f), language="en", vad_filter=True, beam_size=5)
        for seg in segments:
            t = rec["t0"] + seg.start * 1000
            if start <= t <= end and seg.text.strip():
                lines.append((t, who, seg.text.strip()))
        print(f"  {who}: {f.name} done", file=sys.stderr, flush=True)
    lines.sort()
    out = ["# What the recordings say", "",
           f"Written down on this computer from the voice recordings of {folder.name}, by Whisper ({a.model}). "
           "Each line is under the name of the microphone that recorded it; in a team session each microphone can "
           "hear the other person too, so some words appear twice.", ""]
    out += [f"- `{clock(t)}` **{who}:** {text}" for t, who, text in lines]
    (folder / "transcript-recordings.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print(folder / "transcript-recordings.md")


if __name__ == "__main__":
    main()
