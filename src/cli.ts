#!/usr/bin/env node

import * as path from 'node:path';

import {
  convertPdf,
  convertPdfBatch,
  createOcrBatch,
  DEFAULT_BATCH_POLL_INTERVAL_MS,
  DEFAULT_MODEL,
} from './index.js';

const HELP_TEXT = `mistral-ocr

Usage:
  mistral-ocr convert <input.pdf> [options]
  mistral-ocr batch <input.pdf...> [options]
  mistral-ocr <input.pdf> [options]

Options:
  --output-dir <dir>   Base directory for generated files. Default: input PDF directory
  --markdown <path>    Markdown output path. Default: <output-dir>/<basename>.md
  --docx <path>        DOCX output path. Default: <output-dir>/<basename>.docx
  --images-dir <dir>   Directory for extracted images. Default: <output-dir>/<basename>-images
  --model <name>       OCR model to use. Default: ${DEFAULT_MODEL}
  --api-key <key>      Override MISTRAL_API_KEY
  --no-markdown        Do not write the Markdown file
  --no-docx            Do not generate the DOCX file
  --no-images          Do not write extracted images to disk
  --no-wait            Batch only: submit the OCR batch job and exit without downloading outputs
  --poll-interval <s>  Batch only: polling interval in seconds. Default: ${DEFAULT_BATCH_POLL_INTERVAL_MS / 1000}
  --timeout <s>        Batch only: maximum wait time in seconds. Default: no timeout
  -h, --help           Show this help
`;

type CliCommand = 'convert' | 'batch';

interface CliOptions {
  command: CliCommand;
  inputPaths: string[];
  outputDir?: string;
  markdownPath?: string;
  docxPath?: string;
  imagesDir?: string;
  model?: string;
  apiKey?: string;
  writeMarkdown: boolean;
  generateDocx: boolean;
  writeImages: boolean;
  waitForBatch: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

function fail(message: string): never {
  console.error(message);
  console.error('');
  console.error(HELP_TEXT);
  process.exit(1);
}

function shiftValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value) {
    fail(`Missing value for ${flag}.`);
  }
  return value;
}

function parsePositiveSeconds(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`${flag} must be a positive number of seconds.`);
  }
  return Math.round(parsed * 1000);
}

function parseCliArgs(argv: string[]): CliOptions {
  const args = [...argv];
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  let command: CliCommand = 'convert';
  if (args[0] === 'convert') {
    args.shift();
  } else if (args[0] === 'batch') {
    command = 'batch';
    args.shift();
  }

  const inputPaths: string[] = [];
  while (args.length > 0 && !args[0]?.startsWith('-')) {
    inputPaths.push(args.shift()!);
  }

  if (inputPaths.length === 0) {
    fail(command === 'batch' ? 'At least one PDF input path is required.' : 'A PDF input path is required.');
  }

  if (command === 'convert' && inputPaths.length !== 1) {
    fail('The convert command accepts exactly one PDF input path. Use batch for multiple inputs.');
  }

  const cliOptions: CliOptions = {
    command,
    inputPaths,
    writeMarkdown: true,
    generateDocx: true,
    writeImages: true,
    waitForBatch: true,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) {
      continue;
    }

    switch (arg) {
      case '--output-dir':
        cliOptions.outputDir = shiftValue(args, arg);
        break;
      case '--markdown':
        cliOptions.markdownPath = shiftValue(args, arg);
        break;
      case '--docx':
        cliOptions.docxPath = shiftValue(args, arg);
        break;
      case '--images-dir':
        cliOptions.imagesDir = shiftValue(args, arg);
        break;
      case '--model':
        cliOptions.model = shiftValue(args, arg);
        break;
      case '--api-key':
        cliOptions.apiKey = shiftValue(args, arg);
        break;
      case '--no-markdown':
        cliOptions.writeMarkdown = false;
        break;
        case '--no-docx':
          cliOptions.generateDocx = false;
          break;
        case '--no-images':
          cliOptions.writeImages = false;
          break;
        case '--no-wait':
          cliOptions.waitForBatch = false;
          break;
        case '--poll-interval':
          cliOptions.pollIntervalMs = parsePositiveSeconds(shiftValue(args, arg), arg);
          break;
        case '--timeout':
          cliOptions.timeoutMs = parsePositiveSeconds(shiftValue(args, arg), arg);
          break;
        default:
          fail(`Unknown argument: ${arg}`);
      }
    }

  if (!cliOptions.writeMarkdown && !cliOptions.generateDocx) {
    fail('At least one output must remain enabled.');
  }

  if (command === 'convert' && (!cliOptions.waitForBatch || cliOptions.pollIntervalMs || cliOptions.timeoutMs)) {
    fail('Batch-only options require the batch command.');
  }

  if (command === 'batch' && (cliOptions.markdownPath || cliOptions.docxPath || cliOptions.imagesDir)) {
    fail('Batch mode writes one output set per input. Use --output-dir instead of --markdown, --docx, or --images-dir.');
  }

  return cliOptions;
}

async function runConvert(cliOptions: CliOptions): Promise<void> {
  const inputAbsolutePath = path.resolve(cliOptions.inputPaths[0]!);
  const inputDir = path.dirname(inputAbsolutePath);
  const baseName = path.basename(inputAbsolutePath, path.extname(inputAbsolutePath));
  const outputDir = path.resolve(cliOptions.outputDir ?? inputDir);

  const markdownPath =
    cliOptions.writeMarkdown === false
      ? undefined
      : path.resolve(cliOptions.markdownPath ?? path.join(outputDir, `${baseName}.md`));

  const docxPath =
    cliOptions.generateDocx === false
      ? undefined
      : path.resolve(cliOptions.docxPath ?? path.join(outputDir, `${baseName}.docx`));

  const imagesDir =
    cliOptions.writeImages === false
      ? undefined
      : path.resolve(cliOptions.imagesDir ?? path.join(outputDir, `${baseName}-images`));

  const result = await convertPdf(inputAbsolutePath, {
    apiKey: cliOptions.apiKey,
    model: cliOptions.model,
    generateDocx: cliOptions.generateDocx,
    markdownPath,
    docxPath,
    imageOutputDir: imagesDir,
    logger: console,
  });

  console.log('');
  console.log('Done.');
  console.log(`  Pages: ${result.ocrResponse.pages.length}`);
  console.log(`  Images: ${result.images.length}`);
  if (markdownPath) {
    console.log(`  Markdown: ${markdownPath}`);
  }
  if (docxPath) {
    console.log(`  DOCX: ${docxPath}`);
  }
  if (imagesDir) {
    console.log(`  Images dir: ${imagesDir}`);
  }
}

async function runBatch(cliOptions: CliOptions): Promise<void> {
  const inputAbsolutePaths = cliOptions.inputPaths.map((inputPath) => path.resolve(inputPath));
  const outputDir = path.resolve(cliOptions.outputDir ?? process.cwd());

  if (!cliOptions.waitForBatch) {
    const result = await createOcrBatch(inputAbsolutePaths, {
      apiKey: cliOptions.apiKey,
      model: cliOptions.model,
      logger: console,
    });

    console.log('');
    console.log('Batch submitted.');
    console.log(`  Job ID: ${result.job.id}`);
    console.log(`  Status: ${result.job.status}`);
    console.log(`  Files: ${result.files.length}`);
    return;
  }

  const result = await convertPdfBatch(inputAbsolutePaths, {
    apiKey: cliOptions.apiKey,
    model: cliOptions.model,
    outputDir,
    generateDocx: cliOptions.generateDocx,
    writeMarkdown: cliOptions.writeMarkdown,
    writeImages: cliOptions.writeImages,
    pollIntervalMs: cliOptions.pollIntervalMs,
    timeoutMs: cliOptions.timeoutMs,
    logger: console,
  });

  const failed = result.entries.filter((entry) => entry.error);

  console.log('');
  console.log('Batch done.');
  console.log(`  Job ID: ${result.job.id}`);
  console.log(`  Status: ${result.job.status}`);
  console.log(`  Documents: ${result.entries.length}`);
  console.log(`  Failed: ${failed.length}`);
  console.log(`  Output dir: ${outputDir}`);

  for (const entry of failed) {
    console.warn(`  Failed ${entry.fileName}: ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`);
  }
}

async function main(): Promise<void> {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  if (cliOptions.command === 'batch') {
    await runBatch(cliOptions);
    return;
  }

  await runConvert(cliOptions);
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
