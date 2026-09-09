# explore-tavus

Give it a Tavus API key and a document, get a live video conversation about
that document in your browser. One command, no dependencies to install.

Built for **Bangla** documents, works for any language Tavus supports.

## Setup

```bash
cp .env.example .env
# paste your key from platform.tavus.io -> Settings -> API Keys
```

## Talk to a document

```bash
npm start ./my-bangla-doc.pdf
```

That's it. It extracts the text, builds a Tavus PAL wired for Bangla speech,
opens a conversation and launches your browser. Press **Ctrl-C** in the
terminal to end the call.

Accepts `.pdf .docx .doc .odt .rtf .pptx .ppt .xlsx .txt .md .csv .html`.

Flags go after a bare `--` when running through npm:

```bash
npm start ./doc.pdf -- --lang multilingual   # auto-detect Bangla/English
npm start ./doc.pdf -- --reply-lang english  # you speak Bangla, it answers English
npm start ./doc.pdf -- --face r874cc5f8a3b   # pick a specific face
npm start ./doc.pdf -- --keep                # leave the call running after Ctrl-C
npm start ./doc.pdf -- --no-open             # print the URL, don't open a browser
```

## Other commands

```bash
npm run end      # end every active conversation (stops billing)
npm run faces    # list faces available to your key
npm run docs     # list knowledge base documents
npm start -- --help
```

## The two paths, and why

Tavus's Knowledge Base has two constraints that matter here:

1. **English only.** Per the `POST /v2/documents` docs: *"For now, our
   Knowledge Base only supports documents written in English and works best
   for conversations in English."* A Bangla PDF embeds and retrieves badly.
2. **No file upload.** `document_url` must be publicly reachable. Tavus
   fetches it server-side; there is no multipart endpoint.

So this tool picks a path from what you hand it:

| You pass | Path | What happens |
|---|---|---|
| A local file | **Prompt injection** (default) | Text is extracted locally and placed in the PAL's `context`. No hosting, no English-only limit, no retrieval loss. The LLM reads Bangla natively. |
| An `http(s)` URL | **Knowledge Base** | `POST /v2/documents`, poll until `ready`, attach via `document_ids`. Real RAG, subject to the English-only caveat above. |

Prompt injection is capped at 60,000 characters. Past that, host the file and
pass the URL — or translate it to English first and use the Knowledge Base,
which keeps the conversation in Bangla while sourcing facts from English text.

Spoken Bangla itself is fully supported and unaffected by any of this:
Bengali is one of Tavus's 43 languages, and the tool selects the
`tavus-soniox` STT engine, which Tavus recommends for Indic languages.

## Files

```
talk.mjs           CLI and orchestration
lib/tavus.mjs      Tavus REST client (fetch, no deps)
lib/extract.mjs    local document -> plain text
```

Extraction shells out to `pdftotext` (poppler) for PDFs and `soffice`
(LibreOffice) for Office formats. Both were already present on this machine.
A scanned PDF has no text layer and needs OCR first (`ocrmypdf in.pdf out.pdf`).

## API notes

Tavus renamed **persona → PAL** and **replica → Face**. This code uses the
current names (`/v2/pals`, `pal_id`, `default_face_id`). The legacy
`/v2/personas` and `/v2/replicas` paths still work as aliases.

Calls default to a 30-minute `max_call_duration` cap and end on Ctrl-C, so a
forgotten tab does not keep burning credits. `npm run end` sweeps any strays.
