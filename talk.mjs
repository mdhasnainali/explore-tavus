#!/usr/bin/env node
// Give it an API key and a document, get a live Tavus video call about it.
//
//   npm start ./mydoc.pdf                 local file -> text in the prompt
//   npm start https://host/doc.pdf        public URL -> Tavus Knowledge Base
//   npm start ./mydoc.pdf -- --lang english
//   npm run end                           end every active conversation
//   npm run faces                         list faces available to the key
//   npm run docs                          list knowledge base documents

import { basename } from 'node:path';
import { stat, writeFile, readFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { Tavus, TavusError } from './lib/tavus.mjs';
import { extractText } from './lib/extract.mjs';

const SESSION_FILE = new URL('./.tavus-session.json', import.meta.url);

// Tavus caps the prompt, and a huge dump degrades answer quality anyway.
// Past this, the Knowledge Base is the better tool.
const MAX_CONTEXT_CHARS = 60_000;

const FALLBACK_FACE_ID = 'r90bbd427f71';

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = {
    source: null,
    lang: 'bengali',
    replyLang: null,
    face: process.env.TAVUS_FACE_ID || null,
    stt: null,
    maxDuration: 1800,
    keep: false,
    open: true,
    mode: 'talk',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };

    if (a === '--end') opts.mode = 'end';
    else if (a === '--faces') opts.mode = 'faces';
    else if (a === '--docs') opts.mode = 'docs';
    else if (a === '--lang') opts.lang = next().toLowerCase();
    else if (a === '--reply-lang') opts.replyLang = next();
    else if (a === '--face') opts.face = next();
    else if (a === '--stt') opts.stt = next();
    else if (a === '--max-duration') opts.maxDuration = Number(next());
    else if (a === '--keep') opts.keep = true;
    else if (a === '--no-open') opts.open = false;
    else if (a === '-h' || a === '--help') opts.mode = 'help';
    else if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    else if (!opts.source) opts.source = a;
    else throw new Error(`Unexpected extra argument: ${a}`);
  }

  return opts;
}

const HELP = `
Usage: npm start <file-or-url> [-- <flags>]

  <file-or-url>        Local document (.pdf .docx .doc .txt .md .pptx .xlsx ...)
                       or a publicly reachable URL.

Flags (put them after a bare --  when going through npm):
  --lang <name>        Spoken language. Default: bengali. Use "multilingual"
                       to auto-detect and switch mid-call.
  --reply-lang <name>  Language the agent replies in. Defaults to --lang.
  --face <face_id>     Face to use. Default: first face on your account.
  --stt <engine>       STT engine. Default: tavus-soniox for Indic languages,
                       tavus-auto otherwise.
  --max-duration <s>   Hard call length cap in seconds. Default: 1800.
  --keep               Do not end the conversation on Ctrl-C.
  --no-open            Print the URL instead of opening a browser.

Other modes:
  npm run end          End every active conversation on the account.
  npm run faces        List faces available to your API key.
  npm run docs         List knowledge base documents.
`.trim();

// ---------------------------------------------------------------- helpers

const INDIC = new Set([
  'bengali', 'hindi', 'tamil', 'telugu', 'gujarati',
  'kannada', 'malayalam', 'marathi', 'punjabi',
]);

// Tavus recommends tavus-soniox for Indic languages; tavus-auto covers all 43.
function pickStt(lang) {
  return INDIC.has(lang) ? 'tavus-soniox' : 'tavus-auto';
}

const isUrl = (s) => /^https?:\/\//i.test(s);

function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer'
    : 'xdg-open';
  execFile(cmd, [url], () => {});
}

async function resolveFaceId(tavus, requested) {
  if (requested) return requested;

  try {
    const res = await tavus.listFaces();
    const list = Array.isArray(res) ? res : (res.data ?? []);
    const first = list.find((f) => f.face_id || f.replica_id);
    if (first) return first.face_id ?? first.replica_id;
  } catch {
    // fall through to the documented stock face
  }
  return FALLBACK_FACE_ID;
}

function buildSystemPrompt(replyLang, viaKb) {
  const where = viaKb
    ? 'the documents in your knowledge base'
    : 'the DOCUMENT provided in your context';

  return [
    `You are a document assistant. Answer strictly from ${where}.`,
    `Always speak and reply in ${titleCase(replyLang)}.`,
    `If the answer is not in ${where}, say so plainly in ${titleCase(replyLang)} instead of guessing.`,
    'Keep answers short and spoken-friendly: two or three sentences unless asked for detail.',
    'Never invent facts, numbers, names or dates that are not in the source.',
  ].join(' ');
}

// ---------------------------------------------------------------- modes

async function modeFaces(tavus) {
  const res = await tavus.listFaces();
  const list = Array.isArray(res) ? res : (res.data ?? []);
  if (!list.length) return console.log('No faces on this account.');

  for (const f of list) {
    const id = f.face_id ?? f.replica_id;
    const name = f.face_name ?? f.replica_name ?? '(unnamed)';
    console.log(`${id}  ${name}${f.status ? `  [${f.status}]` : ''}`);
  }
}

async function modeDocs(tavus) {
  const res = await tavus.listDocuments();
  const list = Array.isArray(res) ? res : (res.data ?? []);
  if (!list.length) return console.log('Knowledge base is empty.');

  for (const d of list) {
    const tags = d.tags?.length ? `  tags=${d.tags.join(',')}` : '';
    console.log(`${d.document_id}  ${d.status.padEnd(10)}  ${d.document_name ?? ''}${tags}`);
  }
}

async function modeEnd(tavus) {
  const res = await tavus.listConversations('active');
  const list = Array.isArray(res) ? res : (res.data ?? []);

  if (!list.length) {
    console.log('No active conversations.');
  } else {
    for (const c of list) {
      await tavus.endConversation(c.conversation_id);
      console.log(`Ended ${c.conversation_id}`);
    }
  }
  await unlink(SESSION_FILE).catch(() => {});
}

async function modeTalk(tavus, opts) {
  if (!opts.source) {
    console.error('Need a document. Try: npm start ./mydoc.pdf\n');
    console.error(HELP);
    process.exit(1);
  }

  const replyLang = opts.replyLang ?? opts.lang;
  const stt = opts.stt ?? pickStt(opts.lang);
  const viaKb = isUrl(opts.source);

  let context = null;
  let documentIds = null;
  let label;

  if (viaKb) {
    // --- Knowledge Base path -------------------------------------------
    console.log('Knowledge Base path (public URL).');
    console.log('Note: Tavus states the Knowledge Base currently supports English');
    console.log('documents only. A Bangla file here may retrieve poorly.\n');

    label = basename(new URL(opts.source).pathname) || 'document';
    const doc = await tavus.createDocument({
      documentUrl: opts.source,
      documentName: label,
      tags: ['explore-tavus'],
    });
    console.log(`Uploaded. document_id=${doc.document_id} status=${doc.status}`);
    console.log('Processing (Tavus says 5-10 min is normal)...');

    let lastLine = '';
    const ready = await tavus.waitForDocument(doc.document_id, {
      onTick: (d) => {
        const line = `  status=${d.status}${d.progress != null ? ` progress=${d.progress}%` : ''}`;
        if (line !== lastLine) {
          console.log(line);
          lastLine = line;
        }
      },
    });
    console.log(`Ready: ${ready.document_name}\n`);
    documentIds = [doc.document_id];
  } else {
    // --- Prompt-injection path -----------------------------------------
    await stat(opts.source).catch(() => {
      throw new Error(`No such file: ${opts.source}`);
    });

    label = basename(opts.source);
    console.log(`Extracting text from ${label} ...`);
    const { text, chars, banglaRatio } = await extractText(opts.source);
    console.log(`  ${chars.toLocaleString()} chars, ${(banglaRatio * 100).toFixed(0)}% Bengali script`);

    if (banglaRatio > 0 && banglaRatio < 0.2) {
      console.log('  Warning: little Bengali script found. Check extraction was clean.');
    }

    let body = text;
    if (chars > MAX_CONTEXT_CHARS) {
      body = text.slice(0, MAX_CONTEXT_CHARS);
      console.log(
        `  Warning: truncated to ${MAX_CONTEXT_CHARS.toLocaleString()} chars. ` +
          'For a document this size, host it publicly and pass the URL to use the Knowledge Base.',
      );
    }
    context = `DOCUMENT: ${label}\n\n${body}`;
    console.log();
  }

  const faceId = await resolveFaceId(tavus, opts.face);
  console.log(`face_id=${faceId}  language=${opts.lang}  stt=${stt}`);

  const pal = await tavus.createPal({
    pal_name: `Doc Agent - ${label}`.slice(0, 60),
    pipeline_mode: 'full',
    default_face_id: faceId,
    system_prompt: buildSystemPrompt(replyLang, viaKb),
    ...(context ? { context } : {}),
    ...(documentIds ? { document_ids: documentIds } : {}),
    layers: {
      stt: { stt_engine: stt },
      perception: { perception_model: 'raven-1' },
      conversational_flow: {
        turn_detection_model: 'sparrow-1',
        turn_taking_patience: 'high',
        pal_interruptibility: 'medium',
      },
    },
  });
  console.log(`pal_id=${pal.pal_id}`);

  const convo = await tavus.createConversation({
    pal_id: pal.pal_id,
    face_id: faceId,
    conversation_name: `Talk about ${label}`.slice(0, 60),
    properties: {
      language: opts.lang,
      max_call_duration: opts.maxDuration,
      participant_absent_timeout: 300,
      participant_left_timeout: 60,
    },
  });

  await writeFile(
    SESSION_FILE,
    JSON.stringify(
      {
        pal_id: pal.pal_id,
        conversation_id: convo.conversation_id,
        conversation_url: convo.conversation_url,
        document_ids: documentIds,
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.log(`conversation_id=${convo.conversation_id}\n`);
  console.log('Ready. Talk here:');
  console.log(`\n  ${convo.conversation_url}\n`);

  if (opts.open) {
    openInBrowser(convo.conversation_url);
    console.log('(opening in your browser)');
  }

  if (opts.keep) {
    console.log('--keep set: conversation left running. End it with `npm run end`.');
    return;
  }

  console.log('Press Ctrl-C here to end the call and stop billing for it.');

  await new Promise((resolve) => {
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      console.log('\nEnding conversation...');
      await tavus.endConversation(convo.conversation_id).catch((e) => {
        console.error(`  could not end it: ${e.message}`);
      });
      await unlink(SESSION_FILE).catch(() => {});
      console.log('Done.');
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'help') return console.log(HELP);

  const apiKey = process.env.TAVUS_API_KEY;
  if (!apiKey) {
    console.error('TAVUS_API_KEY is not set.');
    console.error('Copy .env.example to .env and paste your key from');
    console.error('platform.tavus.io -> Settings -> API Keys');
    process.exit(1);
  }

  const tavus = new Tavus(apiKey);

  if (opts.mode === 'faces') return modeFaces(tavus);
  if (opts.mode === 'docs') return modeDocs(tavus);
  if (opts.mode === 'end') return modeEnd(tavus);
  return modeTalk(tavus, opts);
}

main().catch((err) => {
  if (err instanceof TavusError && err.status === 401) {
    console.error('\nTavus rejected the API key (401). Check TAVUS_API_KEY in .env.');
  } else {
    console.error(`\n${err.message}`);
  }
  process.exit(1);
});
