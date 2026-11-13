import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AiError } from '../../ai/core/errors.ts';

export async function recognizePdfImages(paths, directory) {
  if (process.platform !== 'win32') throw new AiError('OCR_REQUIRED', '이미지 기반 PDF입니다. OCR로 텍스트를 추가한 PDF를 업로드해 주세요. 자동 OCR은 현재 Windows에서 지원합니다.');
  const manifest = join(directory, 'pages.json');
  await writeFile(manifest, JSON.stringify(paths.map((path) => resolve(path))));
  try {
    const script = await readFile(new URL('./ocr.ps1', import.meta.url), 'utf8');
    const quotedManifest = resolve(manifest).replaceAll("'", "''");
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${script} } -Manifest '${quotedManifest}'`], {
      windowsHide: true, timeout: Math.max(60000, paths.length * 15000), maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
    });
    const pages = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!Array.isArray(pages) || pages.length !== paths.length || pages.some((page) => typeof page !== 'string')) throw new Error('Invalid OCR output');
    return pages;
  } catch {
    throw new AiError('OCR_REQUIRED', 'PDF 본문을 읽기 위한 OCR을 완료하지 못했습니다. Windows 한국어 OCR 언어 팩을 확인하거나, OCR로 텍스트를 추가한 PDF를 업로드해 주세요.');
  }
}
