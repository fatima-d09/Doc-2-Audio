/* Doc2Audio — browser-side document reader
 * Extracts text from PDF / DOCX / TXT / MD and reads it aloud with the Web Speech API.
 */
(() => {
  "use strict";

  // ---------- Setup ----------
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const $ = (id) => document.getElementById(id);
  const els = {
    dropZone: $("dropZone"), fileInput: $("fileInput"), status: $("status"),
    player: $("player"), reader: $("reader"), docTitle: $("docTitle"), docStats: $("docStats"),
    progress: $("progress"), posLabel: $("posLabel"), timeLabel: $("timeLabel"),
    playBtn: $("playBtn"), prevBtn: $("prevBtn"), nextBtn: $("nextBtn"), stopBtn: $("stopBtn"),
    voiceSelect: $("voiceSelect"), rate: $("rate"), rateOut: $("rateOut"),
    pitch: $("pitch"), pitchOut: $("pitchOut"), autoScroll: $("autoScroll"),
    downloadTxt: $("downloadTxt"), newFile: $("newFile"), themeToggle: $("themeToggle"),
  };

  const synth = window.speechSynthesis;
  const WORDS_PER_MIN = 165; // average speaking speed at 1.0×

  const state = {
    fileName: "", text: "", chunks: [], spans: [],
    idx: 0, playing: false, token: 0, voices: [],
  };

  // Safe localStorage helpers (can throw in private mode etc.)
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------- Status ----------
  function setStatus(msg, isError = false) {
    els.status.textContent = msg;
    els.status.classList.toggle("error", isError);
  }

  // ---------- Text extraction ----------
  async function extractPdf(file) {
    if (!window.pdfjsLib) throw new Error("PDF library failed to load (are you offline?).");
    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      setStatus(`Reading page ${p} of ${pdf.numPages}…`);
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      let out = "";
      let lastY = null;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform ? item.transform[5] : null;
        // A noticeable jump in Y means a new line
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !out.endsWith("\n")) out += "\n";
        out += item.str;
        if (item.hasEOL) out += "\n";
        lastY = y;
      }
      pages.push(out);
    }
    return { text: pages.map((t, i) => `\f${i + 1}\n${t}`).join("\n\n"), pages: pdf.numPages };
  }

  async function extractDocx(file) {
    if (!window.mammoth) throw new Error("DOCX library failed to load (are you offline?).");
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return { text: result.value };
  }

  async function extractPlain(file) {
    let text = await file.text();
    if (/\.(md|markdown)$/i.test(file.name)) text = stripMarkdown(text);
    return { text };
  }

  function stripMarkdown(md) {
    return md
      .replace(/```[\s\S]*?```/g, "")            // code blocks
      .replace(/`([^`]+)`/g, "$1")                // inline code
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")      // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")   // links
      .replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, "$1.") // headings → sentences
      .replace(/^\s*[-*+]\s+/gm, "")              // bullets
      .replace(/^\s*>\s?/gm, "")                  // quotes
      .replace(/(\*\*|__|\*|_|~~)(.*?)\1/g, "$2"); // emphasis
  }

  // Normalize: join hyphenated line breaks, merge wrapped lines, keep paragraphs.
  function cleanText(raw) {
    return raw
      .replace(/\r\n?/g, "\n")
      .replace(/\u00ad/g, "")                     // soft hyphens
      .replace(/(\w)-\n(\w)/g, "$1$2")            // hyphenation across lines
      .replace(/[ \t]+/g, " ")
      .replace(/([^\n.!?:;])\n(?!\n|\f)/g, "$1 ")  // single line breaks mid-sentence
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ---------- Chunking into sentences ----------
  const MAX_CHUNK = 260; // keep utterances short: avoids Chrome's ~15s cut-off bug

  function splitSentences(paragraph) {
    const parts = paragraph.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g) || [paragraph];
    const out = [];
    let buf = "";
    for (let s of parts) {
      s = s.trim();
      if (!s) continue;
      // Merge very short fragments (e.g. "Dr.", "1.") with the next sentence
      if ((buf + " " + s).length < 60 || /\b(Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e|Fig|No)\.$/i.test(buf)) {
        buf = buf ? `${buf} ${s}` : s;
        continue;
      }
      if (buf) out.push(buf);
      buf = s;
    }
    if (buf) out.push(buf);
    return out.flatMap(splitLong);
  }

  function splitLong(s) {
    if (s.length <= MAX_CHUNK) return [s];
    const out = [];
    let rest = s;
    while (rest.length > MAX_CHUNK) {
      let cut = Math.max(rest.lastIndexOf(", ", MAX_CHUNK), rest.lastIndexOf("; ", MAX_CHUNK));
      if (cut < MAX_CHUNK * 0.4) cut = rest.lastIndexOf(" ", MAX_CHUNK);
      if (cut <= 0) cut = MAX_CHUNK;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  // ---------- Rendering ----------
  function render(text) {
    els.reader.innerHTML = "";
    state.chunks = [];
    state.spans = [];
    const frag = document.createDocumentFragment();

    for (const block of text.split(/\n{2,}/)) {
      let b = block;
      const pageMatch = b.match(/^\f(\d+)\n?/);
      if (pageMatch) {
        const mark = document.createElement("div");
        mark.className = "page-mark";
        mark.textContent = `Page ${pageMatch[1]}`;
        frag.appendChild(mark);
        b = b.slice(pageMatch[0].length);
      }
      b = b.replace(/\s+/g, " ").trim();
      if (!b) continue;

      const p = document.createElement("p");
      splitSentences(b).forEach((sentence) => {
        const span = document.createElement("span");
        span.className = "s";
        span.dataset.i = state.chunks.length;
        span.textContent = sentence + " ";
        p.appendChild(span);
        state.chunks.push(sentence);
        state.spans.push(span);
      });
      frag.appendChild(p);
    }
    els.reader.appendChild(frag);
  }

  // ---------- Speech ----------
  function currentVoice() {
    return state.voices.find((v) => v.voiceURI === els.voiceSelect.value) || null;
  }

  function speak(i) {
    if (i < 0 || i >= state.chunks.length) { finish(); return; }
    synth.cancel();
    state.idx = i;
    state.playing = true;
    const myToken = ++state.token;
    highlight(i);
    updatePlayButton();

    const u = new SpeechSynthesisUtterance(state.chunks[i]);
    const v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = parseFloat(els.rate.value);
    u.pitch = parseFloat(els.pitch.value);

    u.onend = () => {
      if (myToken !== state.token || !state.playing) return;
      speak(state.idx + 1);
    };
    u.onerror = (e) => {
      if (e.error === "interrupted" || e.error === "canceled") return;
      console.warn("Speech error:", e.error);
      if (myToken === state.token && state.playing) speak(state.idx + 1);
    };
    // Some browsers need a tick after cancel() before speak()
    setTimeout(() => { if (myToken === state.token) synth.speak(u); }, 30);
  }

  function pause() {
    state.playing = false;
    state.token++;
    synth.cancel(); // more reliable than synth.pause() across browsers
    updatePlayButton();
  }

  function stop() {
    pause();
    state.idx = 0;
    highlight(0);
  }

  function finish() {
    state.playing = false;
    updatePlayButton();
    setStatus("Finished reading. 🎉");
    state.idx = 0;
    savePosition();
  }

  function toggle() {
    if (!state.chunks.length) return;
    state.playing ? pause() : speak(state.idx);
  }

  function restartIfPlaying() {
    if (state.playing) speak(state.idx);
  }

  // ---------- UI updates ----------
  function highlight(i) {
    state.spans.forEach((s, k) => {
      s.classList.toggle("active", k === i);
      s.classList.toggle("read", k < i);
    });
    const span = state.spans[i];
    if (span && els.autoScroll.checked) {
      const r = els.reader;
      const top = span.offsetTop - r.offsetTop - r.clientHeight / 2 + span.offsetHeight / 2;
      r.scrollTo({ top, behavior: "smooth" });
    }
    els.progress.value = i;
    els.posLabel.textContent = `${Math.min(i + 1, state.chunks.length)} / ${state.chunks.length}`;
    els.timeLabel.textContent = remainingTime(i);
    savePosition();
  }

  function remainingTime(i) {
    const words = state.chunks.slice(i).join(" ").split(/\s+/).filter(Boolean).length;
    const mins = words / (WORDS_PER_MIN * parseFloat(els.rate.value));
    if (mins < 1) return "< 1 min left";
    const h = Math.floor(mins / 60), m = Math.round(mins % 60);
    return h ? `${h} h ${m} min left` : `${m} min left`;
  }

  function updatePlayButton() {
    els.playBtn.textContent = state.playing ? "❚❚" : "▶";
    els.playBtn.setAttribute("aria-label", state.playing ? "Pause" : "Play");
  }

  // ---------- Voices ----------
  function loadVoices() {
    const voices = synth.getVoices();
    if (!voices.length) return;
    state.voices = voices.slice().sort((a, b) =>
      a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    const saved = store.get("d2a.voice");
    const docLang = (document.documentElement.lang || "en").slice(0, 2);
    els.voiceSelect.innerHTML = "";
    for (const v of state.voices) {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})${v.default ? " — default" : ""}`;
      els.voiceSelect.appendChild(opt);
    }
    const pick = state.voices.find((v) => v.voiceURI === saved)
      || state.voices.find((v) => v.default && v.lang.startsWith(docLang))
      || state.voices.find((v) => v.lang.startsWith(docLang))
      || state.voices[0];
    if (pick) els.voiceSelect.value = pick.voiceURI;
  }

  // ---------- Position memory ----------
  function posKey() { return `d2a.pos.${state.fileName}.${state.chunks.length}`; }
  function savePosition() { if (state.fileName) store.set(posKey(), state.idx); }

  // ---------- File handling ----------
  async function handleFile(file) {
    if (!file) return;
    pause();
    const name = file.name;
    const ext = (name.split(".").pop() || "").toLowerCase();
    setStatus(`Opening “${name}”…`);

    try {
      let result;
      if (ext === "pdf" || file.type === "application/pdf") result = await extractPdf(file);
      else if (ext === "docx") result = await extractDocx(file);
      else if (["txt", "md", "markdown"].includes(ext) || file.type.startsWith("text/")) result = await extractPlain(file);
      else if (ext === "doc") throw new Error("Old .doc files aren't supported. Save it as .docx or PDF first.");
      else throw new Error(`Unsupported file type: .${ext}`);

      const text = cleanText(result.text);
      const plain = text.replace(/\f\d+\n?/g, "");
      if (plain.replace(/\s/g, "").length < 2) {
        throw new Error("No readable text found. If this is a scanned PDF, it needs OCR first.");
      }

      state.fileName = name;
      state.text = plain;
      render(text);

      const words = plain.split(/\s+/).filter(Boolean).length;
      els.docTitle.textContent = name.replace(/\.[^.]+$/, "");
      els.docStats.textContent =
        `${words.toLocaleString()} words${result.pages ? ` · ${result.pages} pages` : ""} · ~${Math.max(1, Math.round(words / WORDS_PER_MIN))} min at 1×`;

      els.progress.max = Math.max(0, state.chunks.length - 1);
      els.player.hidden = false;
      els.reader.hidden = false;
      els.dropZone.classList.add("compact");

      const saved = store.get(posKey(), 0);
      state.idx = saved > 0 && saved < state.chunks.length ? saved : 0;
      highlight(state.idx);
      setStatus(state.idx > 0
        ? `Ready. Resuming where you left off (sentence ${state.idx + 1}). Press ▶ to play.`
        : "Ready. Press ▶ to start listening.");
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Could not read that file.", true);
    }
  }

  function downloadText() {
    if (!state.text) return;
    const blob = new Blob([state.text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = state.fileName.replace(/\.[^.]+$/, "") + ".txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Theme ----------
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  applyTheme(store.get("d2a.theme"));
  els.themeToggle.addEventListener("click", () => {
    const isDark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = isDark ? "light" : "dark";
    applyTheme(next);
    store.set("d2a.theme", next);
  });

  // ---------- Events ----------
  els.fileInput.addEventListener("change", (e) => {
    handleFile(e.target.files[0]);
    e.target.value = ""; // allow re-opening the same file
  });

  ["dragenter", "dragover"].forEach((ev) =>
    els.dropZone.addEventListener(ev, (e) => { e.preventDefault(); els.dropZone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    els.dropZone.addEventListener(ev, (e) => { e.preventDefault(); els.dropZone.classList.remove("dragover"); }));
  els.dropZone.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));

  els.playBtn.addEventListener("click", toggle);
  els.stopBtn.addEventListener("click", stop);
  els.prevBtn.addEventListener("click", () => {
    const i = Math.max(0, state.idx - 1);
    state.playing ? speak(i) : (state.idx = i, highlight(i));
  });
  els.nextBtn.addEventListener("click", () => {
    const i = Math.min(state.chunks.length - 1, state.idx + 1);
    state.playing ? speak(i) : (state.idx = i, highlight(i));
  });

  els.progress.addEventListener("input", () => {
    const i = parseInt(els.progress.value, 10);
    state.idx = i;
    state.playing ? speak(i) : highlight(i);
  });

  els.reader.addEventListener("click", (e) => {
    const s = e.target.closest(".s");
    if (s) speak(parseInt(s.dataset.i, 10));
  });

  els.rate.addEventListener("input", () => {
    els.rateOut.textContent = `${parseFloat(els.rate.value).toFixed(1)}×`;
    els.timeLabel.textContent = remainingTime(state.idx);
  });
  els.rate.addEventListener("change", () => { store.set("d2a.rate", els.rate.value); restartIfPlaying(); });
  els.pitch.addEventListener("input", () => { els.pitchOut.textContent = parseFloat(els.pitch.value).toFixed(1); });
  els.pitch.addEventListener("change", () => { store.set("d2a.pitch", els.pitch.value); restartIfPlaying(); });
  els.voiceSelect.addEventListener("change", () => { store.set("d2a.voice", els.voiceSelect.value); restartIfPlaying(); });

  els.downloadTxt.addEventListener("click", downloadText);
  els.newFile.addEventListener("click", () => els.fileInput.click());

  document.addEventListener("keydown", (e) => {
    if (!state.chunks.length) return;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)
        && document.activeElement.type !== "range") return;
    if (e.code === "Space") { e.preventDefault(); toggle(); }
    else if (e.code === "ArrowRight") { e.preventDefault(); els.nextBtn.click(); }
    else if (e.code === "ArrowLeft") { e.preventDefault(); els.prevBtn.click(); }
  });

  window.addEventListener("beforeunload", () => synth && synth.cancel());

  // ---------- Init ----------
  if (!synth || !window.SpeechSynthesisUtterance) {
    setStatus("Your browser doesn't support speech synthesis. Try Chrome, Edge, Safari or Firefox.", true);
  } else {
    loadVoices();
    synth.onvoiceschanged = loadVoices;
  }
  const savedRate = store.get("d2a.rate");
  const savedPitch = store.get("d2a.pitch");
  if (savedRate) { els.rate.value = savedRate; els.rateOut.textContent = `${parseFloat(savedRate).toFixed(1)}×`; }
  if (savedPitch) { els.pitch.value = savedPitch; els.pitchOut.textContent = parseFloat(savedPitch).toFixed(1); }
})();
