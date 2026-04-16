#!/usr/bin/env node

import * as path from 'node:path';

import { convertPdf, DEFAULT_MODEL } from './index.js';

const HELP_TEXT = `mistral-ocr

Usage:
  mistral-ocr convert <input.pdf> [options]
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
  -h, --help           Show this help
`;

interface CliOptions {
  inputPath: string;
  outputDir?: string;
  markdownPath?: string;
  docxPath?: string;
  imagesDir?: string;
  model?: string;
  apiKey?: string;
  writeMarkdown: boolean;
  generateDocx: boolean;
  writeImages: boolean;
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

function parseCliArgs(argv: string[]): CliOptions {
  const args = [...argv];
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (args[0] === 'convert') {
    args.shift();
  }

  const inputPath = args.shift();
  if (!inputPath) {
    fail('A PDF input path is required.');
  }

  const cliOptions: CliOptions = {
    inputPath,
    writeMarkdown: true,
    generateDocx: true,
    writeImages: true,
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
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  if (!cliOptions.writeMarkdown && !cliOptions.generateDocx) {
    fail('At least one output must remain enabled.');
  }

  return cliOptions;
}

async function main(): Promise<void> {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  const inputAbsolutePath = path.resolve(cliOptions.inputPath);
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

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
