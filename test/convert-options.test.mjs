import assert from 'node:assert/strict';
import test from 'node:test';

import { convertPdf } from '../build/index.js';

test('convertPdf forwards OCR 4 options to the SDK request', async () => {
  const ocrRequests = [];
  const client = {
    files: {
      async upload(request) {
        assert.equal(request.purpose, 'ocr');
        return { id: 'file-1' };
      },
    },
    ocr: {
      async process(request) {
        ocrRequests.push(request);
        return {
          pages: [
            {
              index: 0,
              markdown: '# OCR 4',
              images: [],
              dimensions: { dpi: 200, height: 100, width: 100 },
            },
          ],
          model: request.model,
          usageInfo: { pagesProcessed: 1 },
        };
      },
    },
  };

  await convertPdf(Buffer.from('%PDF-1.4\n% test\n'), {
    client,
    generateDocx: false,
    logger: false,
    tableFormat: 'html',
    extractHeader: true,
    extractFooter: true,
    imageLimit: 8,
    imageMinSize: 96,
    documentAnnotationPrompt: 'Extract summary.',
    documentAnnotationFormat: {
      type: 'json_schema',
      jsonSchema: {
        name: 'summary',
        schema: { type: 'object' },
      },
    },
  });

  assert.deepEqual(ocrRequests[0], {
    model: 'mistral-ocr-4-0',
    document: {
      type: 'file',
      fileId: 'file-1',
    },
    includeImageBase64: true,
    imageLimit: 8,
    imageMinSize: 96,
    documentAnnotationFormat: {
      type: 'json_schema',
      jsonSchema: {
        name: 'summary',
        schema: { type: 'object' },
      },
    },
    documentAnnotationPrompt: 'Extract summary.',
    tableFormat: 'html',
    extractHeader: true,
    extractFooter: true,
  });
});
