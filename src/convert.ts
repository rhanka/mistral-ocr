import { Mistral } from '@mistralai/mistralai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { markdownToDocx } from './docx.js';
import type { ConvertPdfOptions, ConvertPdfResult, ExtractedImage, Logger, PdfInput } from './types.js';

export const DEFAULT_MODEL = 'mistral-ocr-latest';
export const DEFAULT_PAGE_SEPARATOR = '\n\n---\n\n';

const DEFAULT_PDF_FILE_NAME = 'document.pdf';
const SILENT_LOGGER: Logger = {
  log() {},
  warn() {},
};

function getLogger(logger?: Logger | false): Logger {
  if (logger === false) {
    return SILENT_LOGGER;
  }

  if (logger) {
    return {
      log: logger.log.bind(logger),
      warn: logger.warn?.bind(logger) ?? logger.log.bind(logger),
    };
  }

  return {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };
}

async function normalizePdfInput(input: PdfInput): Promise<{ fileName: string; buffer: Buffer }> {
  if (typeof input === 'string') {
    return {
      fileName: path.basename(input),
      buffer: await fs.readFile(input),
    };
  }

  if (Buffer.isBuffer(input)) {
    return {
      fileName: DEFAULT_PDF_FILE_NAME,
      buffer: input,
    };
  }

  if (input instanceof Uint8Array) {
    return {
      fileName: DEFAULT_PDF_FILE_NAME,
      buffer: Buffer.from(input),
    };
  }

  if (input.filePath) {
    return {
      fileName: input.fileName ?? path.basename(input.filePath),
      buffer: await fs.readFile(input.filePath),
    };
  }

  if (input.buffer) {
    return {
      fileName: input.fileName ?? DEFAULT_PDF_FILE_NAME,
      buffer: Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer),
    };
  }

  throw new Error('A PDF path or buffer is required.');
}

function createExtensionFromImageBase64(imageBase64: string): { base64: string; extension: string } {
  const dataUriMatch = imageBase64.match(/^data:image\/([^;]+);base64,(.+)$/s);
  if (!dataUriMatch) {
    return {
      base64: imageBase64,
      extension: 'png',
    };
  }

  const [, rawExtension, base64] = dataUriMatch;
  const normalizedExtension = rawExtension.split('+')[0] === 'jpeg' ? 'jpg' : rawExtension.split('+')[0];
  return {
    base64,
    extension: normalizedExtension,
  };
}

export function extractImagesFromOcrResponse(ocrResponse: ConvertPdfResult['ocrResponse']): ExtractedImage[] {
  const images: ExtractedImage[] = [];

  for (const page of ocrResponse.pages) {
    for (const image of page.images) {
      if (!image.imageBase64) {
        continue;
      }

      const { base64, extension } = createExtensionFromImageBase64(image.imageBase64);
      images.push({
        id: image.id,
        extension,
        buffer: Buffer.from(base64, 'base64'),
      });
    }
  }

  return images;
}

function ensurePosixPath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

export async function writeExtractedImages(
  images: ExtractedImage[],
  imageOutputDir: string,
  referenceBaseDir = imageOutputDir,
): Promise<ExtractedImage[]> {
  const absoluteOutputDir = path.resolve(imageOutputDir);
  const absoluteReferenceBaseDir = path.resolve(referenceBaseDir);
  await fs.mkdir(absoluteOutputDir, { recursive: true });

  const writtenImages: ExtractedImage[] = [];
  for (const [index, image] of images.entries()) {
    const filename = `image-${String(index).padStart(3, '0')}.${image.extension}`;
    const absolutePath = path.join(absoluteOutputDir, filename);
    await fs.writeFile(absolutePath, image.buffer);

    writtenImages.push({
      ...image,
      absolutePath,
      relativePath: ensurePosixPath(path.relative(absoluteReferenceBaseDir, absolutePath)),
    });
  }

  return writtenImages;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceImageReference(markdown: string, imageSource: string, replacement: string): string {
  const pattern = new RegExp(`(!\\[[^\\]]*\\]\\()<?${escapeRegExp(imageSource)}>?(\\))`, 'g');
  return markdown.replace(pattern, `$1${replacement}$2`);
}

export function buildMarkdownFromOcrResponse(
  ocrResponse: ConvertPdfResult['ocrResponse'],
  imageReplacements: Map<string, string> = new Map(),
  pageSeparator = DEFAULT_PAGE_SEPARATOR,
): string {
  return ocrResponse.pages
    .map((page) => {
      let pageMarkdown = page.markdown;
      for (const image of page.images) {
        const replacement = imageReplacements.get(image.id);
        if (replacement) {
          pageMarkdown = replaceImageReference(pageMarkdown, image.id, replacement);
        }
      }
      return pageMarkdown;
    })
    .join(pageSeparator);
}

function createImagesBySource(images: ExtractedImage[]): Map<string, Buffer> {
  const imagesBySource = new Map<string, Buffer>();
  for (const image of images) {
    imagesBySource.set(image.id, image.buffer);
    if (image.absolutePath) {
      imagesBySource.set(image.absolutePath, image.buffer);
    }
    if (image.relativePath) {
      imagesBySource.set(image.relativePath, image.buffer);
    }
  }
  return imagesBySource;
}

function resolveReferenceBaseDir(options: ConvertPdfOptions): string {
  if (options.markdownPath) {
    return path.dirname(path.resolve(options.markdownPath));
  }

  if (options.docxPath) {
    return path.dirname(path.resolve(options.docxPath));
  }

  return process.cwd();
}

export function createMistralClient(apiKey = process.env.MISTRAL_API_KEY): Mistral {
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY is required. Pass apiKey or set the environment variable.');
  }

  return new Mistral({ apiKey });
}

export async function convertPdf(
  input: PdfInput,
  options: ConvertPdfOptions = {},
): Promise<ConvertPdfResult> {
  if (options.generateDocx === false && options.docxPath) {
    throw new Error('docxPath cannot be used when generateDocx is false.');
  }

  const logger = getLogger(options.logger);
  const normalizedInput = await normalizePdfInput(input);
  const client = options.client ?? createMistralClient(options.apiKey);
  const model = options.model ?? DEFAULT_MODEL;
  const shouldGenerateDocx = options.generateDocx ?? true;

  logger.log(`[1/4] Uploading ${normalizedInput.fileName} to Mistral...`);
  const uploaded = await client.files.upload({
    file: {
      fileName: normalizedInput.fileName,
      content: normalizedInput.buffer,
    },
    purpose: 'ocr',
  });

  logger.log(`[2/4] Running OCR with ${model}...`);
  const ocrResponse = await client.ocr.process({
    model,
    document: {
      type: 'file',
      fileId: uploaded.id,
    },
    includeImageBase64: true,
  });

  logger.log('[3/4] Building Markdown and extracting images...');
  const extractedImages = extractImagesFromOcrResponse(ocrResponse);
  const referenceBaseDir = resolveReferenceBaseDir(options);
  const writtenImages = options.imageOutputDir
    ? await writeExtractedImages(extractedImages, options.imageOutputDir, referenceBaseDir)
    : extractedImages;

  const imageReplacements = new Map<string, string>();
  for (const image of writtenImages) {
    if (image.relativePath) {
      imageReplacements.set(image.id, image.relativePath);
    }
  }

  const markdown = buildMarkdownFromOcrResponse(
    ocrResponse,
    imageReplacements,
    options.pageSeparator ?? DEFAULT_PAGE_SEPARATOR,
  );

  if (options.markdownPath) {
    await ensureParentDir(options.markdownPath);
    await fs.writeFile(options.markdownPath, markdown, 'utf8');
    logger.log(`  Markdown saved to ${options.markdownPath}`);
  }

  let docxBuffer: Buffer | undefined;
  if (shouldGenerateDocx) {
    logger.log('[4/4] Generating DOCX...');
    docxBuffer = await markdownToDocx(markdown, {
      assetBaseDir: referenceBaseDir,
      imagesBySource: createImagesBySource(writtenImages),
    });

    if (options.docxPath) {
      await ensureParentDir(options.docxPath);
      await fs.writeFile(options.docxPath, docxBuffer);
      logger.log(`  DOCX saved to ${options.docxPath}`);
    }
  }

  return {
    fileName: normalizedInput.fileName,
    markdown,
    markdownPath: options.markdownPath,
    docxBuffer,
    docxPath: options.docxPath,
    images: writtenImages,
    ocrResponse,
  };
}
