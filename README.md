# Doc-2-Audio
Turn PDF, Word (.docx), TXT and Markdown documents into audio

🔗 **Live site:** https://YOUR-USERNAME.github.io/YOUR-REPO/

## Two parts:
 
| Part | What it does | Runs on |
|---|---|---|
| `index.html` + `style.css` + `app.js` | Read any document aloud in the browser, with sentence highlighting, voice/speed/pitch controls, click-to-jump, and resume-where-you-left-off | **GitHub Pages** (static, no server) |
| `converter.py` | Exports the document as a **.wav / .mp3 audiobook file** (offline TTS) | Your computer (Python 3.9+) |
 
> Why two parts? GitHub Pages only hosts static files, so Python can't run there. The web app uses the browser's built-in Web Speech API, which can *play* speech but can't *save* it. The Python script fills that gap.


## How it works
 
Everything lives in a single `index.html` file, with no server, build step or install.
 
| Piece | Used for |
|---|---|
| [pdf.js](https://mozilla.github.io/pdf.js/) | Extracting text from PDFs |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) | Extracting text from Word (.docx) files |
| [Web Speech API](https://developer.mozilla.org/docs/Web/API/Web_Speech_API) | Reading the text aloud |
| HTML Canvas | The pixel night sky and constellation |
 
The PDF and Word libraries load from a CDN only when you open one of those file types.

## Browser support
 
Works best in **Chrome, Edge and Safari**. Firefox works too, but on some systems it has fewer voices. The voices you can pick depend on your operating system and browser.
