#!/usr/bin/env python3
"""
Doc2Audio — convert PDF, Word (.docx), TXT and Markdown files into audiobook files.

Uses pypdf + python-docx to extract text and pyttsx3 (offline TTS) to speak it.
Optional MP3 export uses pydub (requires ffmpeg on your PATH).

Examples:
    python converter.py book.pdf                      # -> book.wav
    python converter.py report.docx -o report.mp3     # -> MP3 (needs ffmpeg)
    python converter.py book.pdf --pages 1-20 --rate 190
    python converter.py --list-voices
    python converter.py book.pdf --voice 1 --split 20000   # several part files
"""
from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

SUPPORTED = {".pdf", ".docx", ".txt", ".md", ".markdown"}


# ---------------------------------------------------------------- extraction
def parse_page_range(spec: str | None, total: int) -> list[int]:
    """'1-5,8,10-' -> zero-based page indexes."""
    if not spec:
        return list(range(total))
    pages: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start, end = part.split("-", 1)
            s = int(start) if start else 1
            e = int(end) if end else total
            pages.update(range(s - 1, min(e, total)))
        else:
            pages.add(int(part) - 1)
    return sorted(p for p in pages if 0 <= p < total)


def extract_pdf(path: Path, pages: str | None = None) -> str:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception as exc:  # noqa: BLE001
            raise SystemExit(f"PDF is password-protected: {exc}")
    chunks = []
    for i in parse_page_range(pages, len(reader.pages)):
        text = reader.pages[i].extract_text() or ""
        chunks.append(text)
    return "\n\n".join(chunks)


def extract_docx(path: Path) -> str:
    import docx  # python-docx

    document = docx.Document(str(path))
    parts = [p.text for p in document.paragraphs if p.text.strip()]
    # Include table text too
    for table in document.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                parts.append(". ".join(cells))
    return "\n\n".join(parts)


def strip_markdown(md: str) -> str:
    md = re.sub(r"```.*?```", "", md, flags=re.S)
    md = re.sub(r"`([^`]+)`", r"\1", md)
    md = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", md)
    md = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", md)
    md = re.sub(r"^\s{0,3}#{1,6}\s+(.*)$", r"\1.", md, flags=re.M)
    md = re.sub(r"^\s*[-*+]\s+", "", md, flags=re.M)
    md = re.sub(r"^\s*>\s?", "", md, flags=re.M)
    md = re.sub(r"(\*\*|__|\*|_|~~)(.*?)\1", r"\2", md)
    return md


def extract_text(path: Path, pages: str | None = None) -> str:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return extract_pdf(path, pages)
    if ext == ".docx":
        return extract_docx(path)
    if ext in {".txt", ".md", ".markdown"}:
        text = path.read_text(encoding="utf-8", errors="replace")
        return strip_markdown(text) if ext != ".txt" else text
    if ext == ".doc":
        raise SystemExit("Old .doc files aren't supported — save as .docx or PDF first.")
    raise SystemExit(f"Unsupported file type '{ext}'. Supported: {', '.join(sorted(SUPPORTED))}")


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\u00ad", "")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)              # re-join hyphenated words
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"([^\n.!?:;])\n(?!\n)", r"\1 ", text)       # merge wrapped lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_text(text: str, max_chars: int) -> list[str]:
    """Split on paragraph boundaries into parts of roughly max_chars."""
    if max_chars <= 0 or len(text) <= max_chars:
        return [text]
    parts, buf = [], ""
    for para in text.split("\n\n"):
        if buf and len(buf) + len(para) > max_chars:
            parts.append(buf)
            buf = para
        else:
            buf = f"{buf}\n\n{para}" if buf else para
    if buf:
        parts.append(buf)
    return parts


# ---------------------------------------------------------------- speech
def _import_pyttsx3():
    try:
        import pyttsx3
    except ImportError:
        raise SystemExit("Speech needs pyttsx3: pip install pyttsx3  (Linux also: sudo apt install espeak-ng)")
    return pyttsx3


def make_engine(rate: int | None, volume: float | None, voice: str | None):
    pyttsx3 = _import_pyttsx3()

    engine = pyttsx3.init()
    if rate:
        engine.setProperty("rate", rate)
    if volume is not None:
        engine.setProperty("volume", max(0.0, min(1.0, volume)))
    if voice is not None:
        voices = engine.getProperty("voices")
        chosen = None
        if voice.isdigit() and int(voice) < len(voices):
            chosen = voices[int(voice)]
        else:
            chosen = next((v for v in voices if voice.lower() in (v.name or "").lower()
                           or voice == v.id), None)
        if chosen is None:
            raise SystemExit(f"Voice '{voice}' not found. Run with --list-voices.")
        engine.setProperty("voice", chosen.id)
    return engine


def list_voices() -> None:
    pyttsx3 = _import_pyttsx3()

    engine = pyttsx3.init()
    for i, v in enumerate(engine.getProperty("voices")):
        langs = ", ".join(str(lang) for lang in (v.languages or []))
        print(f"[{i}] {v.name}  {langs}\n     id: {v.id}")


def native_ext() -> str:
    # macOS's NSSpeechSynthesizer driver writes AIFF; others write WAV
    return ".aiff" if sys.platform == "darwin" else ".wav"


def synthesize(parts: list[str], out_paths: list[Path], engine) -> None:
    for text, out in zip(parts, out_paths):
        engine.save_to_file(text, str(out))
    engine.runAndWait()


def to_mp3(sources: list[Path], dest: Path, bitrate: str = "64k") -> None:
    try:
        from pydub import AudioSegment
    except ImportError:
        raise SystemExit("MP3 export needs pydub: pip install pydub  (plus ffmpeg installed)")
    combined = AudioSegment.empty()
    for src in sources:
        combined += AudioSegment.from_file(src)
    combined.export(dest, format="mp3", bitrate=bitrate)


# ---------------------------------------------------------------- CLI
def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Convert PDF/DOCX/TXT/MD into an audiobook.")
    ap.add_argument("input", nargs="?", help="Document to convert")
    ap.add_argument("-o", "--output", help="Output file (.wav, .aiff or .mp3). Default: <input>.wav")
    ap.add_argument("-r", "--rate", type=int, default=175, help="Words per minute (default 175)")
    ap.add_argument("--volume", type=float, default=1.0, help="0.0 – 1.0 (default 1.0)")
    ap.add_argument("-v", "--voice", help="Voice index or part of its name (see --list-voices)")
    ap.add_argument("-p", "--pages", help="PDF pages, e.g. '1-10,15,20-'")
    ap.add_argument("--split", type=int, default=0, metavar="CHARS",
                    help="Split into several files of about CHARS characters each")
    ap.add_argument("--text-only", action="store_true", help="Just save the extracted text (.txt)")
    ap.add_argument("--list-voices", action="store_true", help="List installed voices and exit")
    args = ap.parse_args(argv)

    if args.list_voices:
        list_voices()
        return
    if not args.input:
        ap.error("an input file is required")

    src = Path(args.input)
    if not src.exists():
        raise SystemExit(f"File not found: {src}")

    print(f"Extracting text from {src.name} …")
    text = clean_text(extract_text(src, args.pages))
    if len(text.strip()) < 2:
        raise SystemExit("No text found. Scanned PDFs need OCR first (e.g. ocrmypdf).")
    words = len(text.split())
    print(f"  {words:,} words (~{max(1, round(words / args.rate))} min of audio)")

    if args.text_only:
        out = Path(args.output) if args.output else src.with_suffix(".txt")
        out.write_text(text, encoding="utf-8")
        print(f"Saved text → {out}")
        return

    out = Path(args.output) if args.output else src.with_suffix(native_ext())
    want_mp3 = out.suffix.lower() == ".mp3"
    parts = split_text(text, args.split)
    engine = make_engine(args.rate, args.volume, args.voice)

    print(f"Generating speech ({len(parts)} part{'s' if len(parts) > 1 else ''}) — this can take a while …")

    if want_mp3:
        with tempfile.TemporaryDirectory() as tmp:
            raw = [Path(tmp) / f"part_{i:03d}{native_ext()}" for i in range(1, len(parts) + 1)]
            synthesize(parts, raw, engine)
            if len(parts) == 1:
                to_mp3(raw, out)
                print(f"Done → {out}")
            else:
                for i, r in enumerate(raw, 1):
                    dest = out.with_name(f"{out.stem}_part{i:03d}.mp3")
                    to_mp3([r], dest)
                    print(f"  → {dest}")
                print("Done.")
    else:
        if len(parts) == 1:
            targets = [out]
        else:
            targets = [out.with_name(f"{out.stem}_part{i:03d}{out.suffix}") for i in range(1, len(parts) + 1)]
        synthesize(parts, targets, engine)
        for t in targets:
            print(f"  → {t}")
        print("Done.")


if __name__ == "__main__":
    main()
