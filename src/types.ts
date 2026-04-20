import type { Mistral } from '@mistralai/mistralai';

export type PdfInput =
  | string
  | Buffer
  | Uint8Array
  | {
      filePath?: string;
      fileName?: string;
      buffer?: Buffer | Uint8Array;
    };

export type MistralOcrResponse = Awaited<ReturnType<Mistral['ocr']['process']>>;

export interface Logger {
  log(message: string): void;
  warn?(message: string): void;
}

export interface ExtractedImage {
  id: string;
  buffer: Buffer;
  extension: string;
  absolutePath?: string;
  relativePath?: string;
}

export type MistralBatchJob = Awaited<ReturnType<Mistral['batch']['jobs']['create']>>;

export interface ConvertPdfOptions {
  apiKey?: string;
  client?: Mistral;
  model?: string;
  generateDocx?: boolean;
  pageSeparator?: string;
  imageOutputDir?: string;
  markdownPath?: string;
  docxPath?: string;
  logger?: Logger | false;
}

export interface ConvertPdfResult {
  fileName: string;
  markdown: string;
  markdownPath?: string;
  docxBuffer?: Buffer;
  docxPath?: string;
  images: ExtractedImage[];
  ocrResponse: MistralOcrResponse;
}

export interface OcrBatchFile {
  customId: string;
  fileName: string;
  fileId: string;
}

export interface CreateOcrBatchOptions {
  apiKey?: string;
  client?: Mistral;
  model?: string;
  includeImageBase64?: boolean;
  metadata?: Record<string, string>;
  logger?: Logger | false;
}

export interface CreateOcrBatchResult {
  job: MistralBatchJob;
  files: OcrBatchFile[];
}

export interface WaitForOcrBatchOptions {
  apiKey?: string;
  client?: Mistral;
  pollIntervalMs?: number;
  timeoutMs?: number;
  inline?: boolean;
  logger?: Logger | false;
}

export interface OcrBatchOutput {
  customId: string;
  response?: MistralOcrResponse;
  error?: unknown;
  raw: unknown;
}

export interface ConvertPdfBatchOptions extends CreateOcrBatchOptions, WaitForOcrBatchOptions {
  outputDir?: string;
  generateDocx?: boolean;
  writeMarkdown?: boolean;
  writeImages?: boolean;
  pageSeparator?: string;
}

export interface ConvertPdfBatchEntry {
  customId: string;
  fileName: string;
  markdown?: string;
  markdownPath?: string;
  docxBuffer?: Buffer;
  docxPath?: string;
  images: ExtractedImage[];
  ocrResponse?: MistralOcrResponse;
  error?: unknown;
}

export interface ConvertPdfBatchResult {
  job: MistralBatchJob;
  files: OcrBatchFile[];
  entries: ConvertPdfBatchEntry[];
}

export interface MarkdownToDocxOptions {
  assetBaseDir?: string;
  imagesBySource?: Map<string, Buffer> | Record<string, Buffer>;
  maxImageWidth?: number;
}
