# mistral-ocr

`mistral-ocr` converts a PDF into Markdown and/or DOCX using `mistral-ocr-latest`.

The project exposes:

- a `mistral-ocr` CLI
- a reusable JavaScript/TypeScript API

## Installation

Use it as an npm package:

```bash
npm install mistral-ocr
```

For local package development:

```bash
npm install
npm run build
```

Required environment variable:

```bash
export MISTRAL_API_KEY=...
```

## Usage CLI

Standard conversion to Markdown + DOCX with image extraction:

```bash
npx mistral-ocr convert ./document.pdf
```

Default outputs:

- `./document.md`
- `./document.docx`
- `./document-images/`

Main options:

```bash
npx mistral-ocr convert ./document.pdf \
  --output-dir ./out \
  --markdown ./out/document.md \
  --docx ./out/document.docx \
  --images-dir ./out/images \
  --model mistral-ocr-latest
```

Generate Markdown only:

```bash
npx mistral-ocr convert ./document.pdf --no-docx
```

Generate DOCX only:

```bash
npx mistral-ocr convert ./document.pdf --no-markdown
```

## Library Usage

```ts
import { convertPdf } from 'mistral-ocr';

const result = await convertPdf('./document.pdf', {
  markdownPath: './out/document.md',
  docxPath: './out/document.docx',
  imageOutputDir: './out/images',
});

console.log(result.markdown);
console.log(result.docxBuffer?.length);
```

Example without writing to disk:

```ts
import { convertPdf } from 'mistral-ocr';

const result = await convertPdf('./document.pdf', {
  generateDocx: false,
  logger: false,
});

console.log(result.markdown);
```

## Scan-Specific Notes

This library follows the format returned by the Mistral OCR API:

- text is returned as Markdown, page by page
- extracted images are first referenced as placeholders in the OCR Markdown, then remapped to local files when `imageOutputDir` is provided
- DOCX generation is intentionally lightweight and focuses on headings, paragraphs, and images

Practical implications:

- scanned PDFs, multi-column layouts, tables, figures, and captions are generally handled well by `mistral-ocr-latest`
- complex tables, equations, or very rich layouts remain most faithful in the raw Markdown produced by the model
- DOCX output does not try to perfectly reconstruct the original Word-style layout; it aims to produce a usable document

Official references:

- API OCR Mistral: https://docs.mistral.ai/capabilities/OCR/basic_ocr/
- latest public benchmark published for Mistral OCR: https://mistral.ai/news/mistral-ocr-3

## Exported API

- `convertPdf(input, options)`
- `markdownToDocx(markdown, options)`
- `createMistralClient(apiKey?)`
- `buildMarkdownFromOcrResponse(ocrResponse, replacements?)`
- `extractImagesFromOcrResponse(ocrResponse)`
- `writeExtractedImages(images, imageOutputDir, referenceBaseDir?)`

## Development

```bash
npm run build
node build/cli.js --help
```

## Local Tests

For local testing in this workspace, the Mistral key can be loaded from `../top-ai-ideas-fullstack/.env`.

Recommended test PDF:

- `New York illustrated` (Library of Congress, 1878), 122 illustrated pages, public domain
- source page: https://www.loc.gov/item/01014750/
- direct PDF: https://tile.loc.gov/storage-services/public/gdcmassbookdig/newyorkillustrat03newy/newyorkillustrat03newy.pdf

Useful commands:

```bash
npm run build
mkdir -p /tmp/mistral-ocr-tests
curl -L https://tile.loc.gov/storage-services/public/gdcmassbookdig/newyorkillustrat03newy/newyorkillustrat03newy.pdf -o /tmp/mistral-ocr-tests/new-york-illustrated.pdf

bash -lc 'set -a; source ../top-ai-ideas-fullstack/.env >/dev/null 2>&1; set +a; node build/cli.js convert /tmp/mistral-ocr-tests/new-york-illustrated.pdf --output-dir /tmp/mistral-ocr-tests/new-york-illustrated-out'

bash -lc 'set -a; source ../top-ai-ideas-fullstack/.env >/dev/null 2>&1; set +a; node build/cli.js convert CONTRIBUATION_AI_AERONAUTIQUE.pdf --output-dir /tmp/mistral-ocr-tests/contribution-out'
```
