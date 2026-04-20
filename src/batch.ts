import { Mistral } from '@mistralai/mistralai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  buildMarkdownFromOcrResponse,
  DEFAULT_MODEL,
  DEFAULT_PAGE_SEPARATOR,
  extractImagesFromOcrResponse,
  writeExtractedImages,
} from './convert.js';
import { markdownToDocx } from './docx.js';
import type {
  ConvertPdfBatchEntry,
  ConvertPdfBatchOptions,
  ConvertPdfBatchResult,
  CreateOcrBatchOptions,
  CreateOcrBatchResult,
  ExtractedImage,
  Logger,
  MistralBatchJob,
  MistralOcrResponse,
  OcrBatchFile,
  OcrBatchOutput,
  PdfInput,
  WaitForOcrBatchOptions,
} from './types.js';

export const DEFAULT_BATCH_POLL_INTERVAL_MS = 5000;

const TERMINAL_BATCH_STATUSES = new Set(['SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT_EXCEEDED']);
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

function createMistralClient(apiKey = process.env.MISTRAL_API_KEY): Mistral {
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY is required. Pass apiKey or set the environment variable.');
  }

  return new Mistral({ apiKey });
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

function ensurePosixPath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalBatchStatus(status: string): boolean {
  return TERMINAL_BATCH_STATUSES.has(status);
}

function getOutputCustomId(output: Record<string, unknown>, index: number): string {
  const customId = output.customId ?? output.custom_id;
  return typeof customId === 'string' && customId.length > 0 ? customId : String(index);
}

function getOutputResponseBody(output: Record<string, unknown>): unknown {
  const response = output.response;
  if (response && typeof response === 'object' && 'body' in response) {
    return (response as { body?: unknown }).body;
  }
  return output.body;
}

function parseOcrBatchOutput(raw: unknown, index: number): OcrBatchOutput {
  if (!raw || typeof raw !== 'object') {
    return {
      customId: String(index),
      error: new Error('Invalid batch output entry.'),
      raw,
    };
  }

  const output = raw as Record<string, unknown>;
  const customId = getOutputCustomId(output, index);
  const error = output.error;
  const body = getOutputResponseBody(output);

  if (body && typeof body === 'object' && Array.isArray((body as { pages?: unknown }).pages)) {
    return {
      customId,
      response: body as MistralOcrResponse,
      error,
      raw,
    };
  }

  return {
    customId,
    error: error ?? new Error(`Batch output ${customId} does not contain an OCR response body.`),
    raw,
  };
}

async function readStreamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function downloadBatchOutputs(client: Mistral, job: MistralBatchJob): Promise<unknown[]> {
  if (job.outputs && job.outputs.length > 0) {
    return job.outputs;
  }

  if (!job.outputFile) {
    return [];
  }

  const outputStream = await client.files.download({ fileId: job.outputFile });
  const outputText = await readStreamToString(outputStream);
  return outputText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function createUniqueOutputBaseName(fileName: string, seen: Map<string, number>): string {
  const baseName = path.basename(fileName, path.extname(fileName)) || 'document';
  const count = seen.get(baseName) ?? 0;
  seen.set(baseName, count + 1);
  return count === 0 ? baseName : `${baseName}-${count + 1}`;
}

async function writeBatchEntryOutput(
  output: OcrBatchOutput,
  file: OcrBatchFile,
  outputBaseName: string,
  options: ConvertPdfBatchOptions,
): Promise<ConvertPdfBatchEntry> {
  if (!output.response) {
    return {
      customId: output.customId,
      fileName: file.fileName,
      images: [],
      error: output.error,
    };
  }

  const outputDir = options.outputDir ? path.resolve(options.outputDir) : undefined;
  const markdownPath =
    outputDir && options.writeMarkdown !== false ? path.join(outputDir, `${outputBaseName}.md`) : undefined;
  const docxPath =
    outputDir && options.generateDocx !== false ? path.join(outputDir, `${outputBaseName}.docx`) : undefined;
  const imageOutputDir =
    outputDir && options.writeImages !== false ? path.join(outputDir, `${outputBaseName}-images`) : undefined;
  const referenceBaseDir = outputDir ?? process.cwd();

  const extractedImages = extractImagesFromOcrResponse(output.response);
  const writtenImages = imageOutputDir
    ? await writeExtractedImages(extractedImages, imageOutputDir, referenceBaseDir)
    : extractedImages;

  const imageReplacements = new Map<string, string>();
  for (const image of writtenImages) {
    if (image.relativePath) {
      imageReplacements.set(image.id, ensurePosixPath(image.relativePath));
    }
  }

  const markdown = buildMarkdownFromOcrResponse(
    output.response,
    imageReplacements,
    options.pageSeparator ?? DEFAULT_PAGE_SEPARATOR,
  );

  if (markdownPath) {
    await fs.mkdir(path.dirname(markdownPath), { recursive: true });
    await fs.writeFile(markdownPath, markdown, 'utf8');
  }

  let docxBuffer: Buffer | undefined;
  if (options.generateDocx !== false) {
    docxBuffer = await markdownToDocx(markdown, {
      assetBaseDir: referenceBaseDir,
      imagesBySource: createImagesBySource(writtenImages),
    });

    if (docxPath) {
      await fs.mkdir(path.dirname(docxPath), { recursive: true });
      await fs.writeFile(docxPath, docxBuffer);
    }
  }

  return {
    customId: output.customId,
    fileName: file.fileName,
    markdown,
    markdownPath,
    docxBuffer,
    docxPath,
    images: writtenImages,
    ocrResponse: output.response,
  };
}

export async function createOcrBatch(
  inputs: PdfInput[],
  options: CreateOcrBatchOptions = {},
): Promise<CreateOcrBatchResult> {
  if (inputs.length === 0) {
    throw new Error('At least one PDF input is required for batch OCR.');
  }

  const logger = getLogger(options.logger);
  const client = options.client ?? createMistralClient(options.apiKey);
  const model = options.model ?? DEFAULT_MODEL;
  const includeImageBase64 = options.includeImageBase64 ?? true;
  const files: OcrBatchFile[] = [];

  logger.log(`[1/2] Uploading ${inputs.length} PDF file(s) to Mistral...`);
  for (const [index, input] of inputs.entries()) {
    const normalizedInput = await normalizePdfInput(input);
    const uploaded = await client.files.upload({
      file: {
        fileName: normalizedInput.fileName,
        content: normalizedInput.buffer,
      },
      purpose: 'ocr',
    });

    files.push({
      customId: String(index),
      fileName: normalizedInput.fileName,
      fileId: uploaded.id,
    });
  }

  logger.log(`[2/2] Creating OCR batch job with ${model}...`);
  const job = await client.batch.jobs.create({
    requests: files.map((file) => ({
      customId: file.customId,
      body: {
        document: {
          type: 'file',
          file_id: file.fileId,
        },
        include_image_base64: includeImageBase64,
      },
    })),
    model,
    endpoint: '/v1/ocr',
    metadata: options.metadata,
  });

  return { job, files };
}

export async function waitForOcrBatch(
  jobId: string,
  options: WaitForOcrBatchOptions = {},
): Promise<MistralBatchJob> {
  const logger = getLogger(options.logger);
  const client = options.client ?? createMistralClient(options.apiKey);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_BATCH_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  let job = await client.batch.jobs.get({ jobId, inline: false });
  while (!isTerminalBatchStatus(job.status)) {
    if (options.timeoutMs && Date.now() - startedAt > options.timeoutMs) {
      throw new Error(`Timed out waiting for Mistral batch job ${jobId}. Last status: ${job.status}.`);
    }

    logger.log(
      `Batch ${job.id}: ${job.status}, completed ${job.completedRequests}/${job.totalRequests} request(s)...`,
    );
    await sleep(pollIntervalMs);
    job = await client.batch.jobs.get({ jobId, inline: false });
  }

  return client.batch.jobs.get({ jobId, inline: options.inline ?? true });
}

export async function listOcrBatchOutputs(
  job: MistralBatchJob,
  options: { apiKey?: string; client?: Mistral } = {},
): Promise<OcrBatchOutput[]> {
  const client = options.client ?? createMistralClient(options.apiKey);
  const outputs = await downloadBatchOutputs(client, job);
  return outputs.map(parseOcrBatchOutput);
}

export async function convertPdfBatch(
  inputs: PdfInput[],
  options: ConvertPdfBatchOptions = {},
): Promise<ConvertPdfBatchResult> {
  const client = options.client ?? createMistralClient(options.apiKey);
  const logger = getLogger(options.logger);
  const created = await createOcrBatch(inputs, { ...options, client, logger });
  const job = await waitForOcrBatch(created.job.id, { ...options, client, logger, inline: true });

  if (job.status !== 'SUCCESS') {
    logger.warn?.(`Batch ${job.id} finished with status ${job.status}.`);
  }

  const outputs = await listOcrBatchOutputs(job, { client });
  const outputsByCustomId = new Map(outputs.map((output) => [output.customId, output]));
  const seenOutputBaseNames = new Map<string, number>();
  const entries: ConvertPdfBatchEntry[] = [];

  for (const file of created.files) {
    const output = outputsByCustomId.get(file.customId) ?? {
      customId: file.customId,
      error: new Error(`Missing output for batch request ${file.customId}.`),
      raw: null,
    };
    const outputBaseName = createUniqueOutputBaseName(file.fileName, seenOutputBaseNames);
    entries.push(await writeBatchEntryOutput(output, file, outputBaseName, options));
  }

  return {
    job,
    files: created.files,
    entries,
  };
}
