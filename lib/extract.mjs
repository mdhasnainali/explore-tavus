// Pull plain text out of a local document so it can be injected straight
// into the PAL prompt.
//
// Why this exists: Tavus's Knowledge Base only supports English documents,
// and its upload endpoint only accepts a public URL. For a Bangla file on
// disk, putting the text in the prompt sidesteps both problems -- the LLM
// reads Bangla natively, and nothing has to be hosted anywhere.

import { execFile } from 'node:child_process';
import { readFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PLAIN_TEXT = new Set(['.txt', '.md', '.csv', '.json', '.html', '.htm']);
const VIA_LIBREOFFICE = new Set(['.docx', '.doc', '.odt', '.rtf', '.pptx', '.ppt', '.xlsx']);

async function haveCommand(cmd) {
  try {
    await run('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function fromPdf(path) {
  if (!(await haveCommand('pdftotext'))) {
    throw new Error(
      'pdftotext not found. Install poppler (Arch: sudo pacman -S poppler), ' +
        'or convert the PDF to .txt yourself and pass that instead.',
    );
  }
  // -layout keeps table/column structure readable, which matters for
  // Bangla documents where reflowed text can scramble word order.
  const { stdout } = await run('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function fromOffice(path) {
  if (!(await haveCommand('soffice'))) {
    throw new Error(
      'libreoffice/soffice not found, needed to read ' +
        `${extname(path)}. Convert the file to .txt or .pdf and pass that instead.`,
    );
  }
  const outDir = await mkdtemp(join(tmpdir(), 'tavus-extract-'));
  await run(
    'soffice',
    ['--headless', '--convert-to', 'txt:Text (encoded):UTF8', '--outdir', outDir, path],
    { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  );

  const produced = (await readdir(outDir)).filter((f) => f.endsWith('.txt'));
  if (!produced.length) throw new Error(`LibreOffice produced no text for ${basename(path)}.`);
  return readFile(join(outDir, produced[0]), 'utf8');
}

function normalize(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @returns {Promise<{ text: string, chars: number, banglaRatio: number }>}
 */
export async function extractText(path) {
  const ext = extname(path).toLowerCase();

  let raw;
  if (ext === '.pdf') raw = await fromPdf(path);
  else if (VIA_LIBREOFFICE.has(ext)) raw = await fromOffice(path);
  else if (PLAIN_TEXT.has(ext) || ext === '') raw = await readFile(path, 'utf8');
  else throw new Error(`Don't know how to read "${ext}". Convert it to .pdf, .docx or .txt.`);

  const text = normalize(raw);
  if (!text) {
    throw new Error(
      `No text came out of ${basename(path)}. If it is a scanned PDF the pages are images, ` +
        'not text -- it needs OCR first (e.g. `ocrmypdf in.pdf out.pdf`).',
    );
  }

  // Used only to warn when extraction silently mangled the script.
  // Both sides count letters and marks only. Bengali vowel signs are \p{M},
  // and the Bengali block also holds numerals and the taka sign, so counting
  // the raw block against letters alone pushes the ratio above 1.
  const bangla = text.match(/(?=\p{Script=Bengali})[\p{L}\p{M}]/gu)?.length ?? 0;
  const scriptChars = text.match(/[\p{L}\p{M}]/gu)?.length ?? 0;
  const banglaRatio = scriptChars ? bangla / scriptChars : 0;

  return { text, chars: text.length, banglaRatio };
}
