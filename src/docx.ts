import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';

import type { MarkdownToDocxOptions } from './types.js';

const DEFAULT_MAX_IMAGE_WIDTH = 550;

function stripSimpleMarkdown(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
}

function normalizeMarkdownImageSource(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getImageFromRegistry(
  source: string,
  registry?: MarkdownToDocxOptions['imagesBySource'],
): Buffer | undefined {
  if (!registry) {
    return undefined;
  }

  const normalizedSource = normalizeMarkdownImageSource(source);
  if (registry instanceof Map) {
    return registry.get(normalizedSource) ?? registry.get(source);
  }

  return registry[normalizedSource] ?? registry[source];
}

function resolveImagePath(source: string, assetBaseDir?: string): string | undefined {
  const normalizedSource = normalizeMarkdownImageSource(source);
  if (path.isAbsolute(normalizedSource) && fs.existsSync(normalizedSource)) {
    return normalizedSource;
  }

  if (assetBaseDir) {
    const candidate = path.resolve(assetBaseDir, normalizedSource);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const cwdCandidate = path.resolve(normalizedSource);
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  return undefined;
}

function getImageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) {
    return null;
  }

  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }

  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset < buf.length - 8) {
      if (buf[offset] !== 0xff) {
        break;
      }

      const marker = buf[offset + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        };
      }

      const blockLength = buf.readUInt16BE(offset + 2);
      offset += 2 + blockLength;
    }
  }

  return null;
}

function inferImageType(buf: Buffer, source: string): 'png' | 'jpg' {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return 'jpg';
  }

  const lowerSource = source.toLowerCase();
  if (lowerSource.endsWith('.jpg') || lowerSource.endsWith('.jpeg')) {
    return 'jpg';
  }

  return 'png';
}

async function resolveImageData(
  source: string,
  options: MarkdownToDocxOptions,
): Promise<Buffer | undefined> {
  const fromRegistry = getImageFromRegistry(source, options.imagesBySource);
  if (fromRegistry) {
    return fromRegistry;
  }

  const imagePath = resolveImagePath(source, options.assetBaseDir);
  if (!imagePath) {
    return undefined;
  }

  return fs.promises.readFile(imagePath);
}

export async function markdownToDocx(
  markdown: string,
  options: MarkdownToDocxOptions = {},
): Promise<Buffer> {
  const lines = markdown.split('\n');
  const children: Paragraph[] = [];
  let currentParagraphRuns: TextRun[] = [];

  const flushParagraph = () => {
    if (currentParagraphRuns.length === 0) {
      return;
    }

    children.push(new Paragraph({ children: currentParagraphRuns }));
    currentParagraphRuns = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed === '---') {
      flushParagraph();
      continue;
    }

    if (trimmed === '') {
      flushParagraph();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const headingLevels = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
        4: HeadingLevel.HEADING_4,
        5: HeadingLevel.HEADING_5,
        6: HeadingLevel.HEADING_6,
      } as const;

      children.push(
        new Paragraph({
          heading: headingLevels[level],
          children: [new TextRun({ text: stripSimpleMarkdown(headingMatch[2]), bold: true })],
        }),
      );
      continue;
    }

    const imageMatch = trimmed.match(/^!\[([^\]]*)\]\((.+)\)$/);
    if (imageMatch) {
      flushParagraph();

      const [, altText, source] = imageMatch;
      const imageBuffer = await resolveImageData(source, options);
      if (!imageBuffer) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: `[Image not found: ${source}]`, italics: true })],
          }),
        );
        continue;
      }

      const dimensions = getImageDimensions(imageBuffer);
      const maxImageWidth = options.maxImageWidth ?? DEFAULT_MAX_IMAGE_WIDTH;
      const width = dimensions ? Math.min(dimensions.width, maxImageWidth) : maxImageWidth;
      const height = dimensions
        ? Math.round(width * (dimensions.height / dimensions.width))
        : Math.round(maxImageWidth * 0.7);

      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: imageBuffer,
              transformation: { width, height },
              type: inferImageType(imageBuffer, source),
            }),
          ],
        }),
      );

      if (altText) {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: altText, italics: true, size: 20 })],
          }),
        );
      }

      continue;
    }

    const text = stripSimpleMarkdown(trimmed);
    currentParagraphRuns.push(new TextRun({ text: `${text} ` }));
  }

  flushParagraph();

  const doc = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
