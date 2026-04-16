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

export interface MarkdownToDocxOptions {
  assetBaseDir?: string;
  imagesBySource?: Map<string, Buffer> | Record<string, Buffer>;
  maxImageWidth?: number;
}
