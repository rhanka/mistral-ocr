import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { convertPdfBatch, createOcrBatch } from '../build/index.js';

function createWorkspaceTemp(prefix) {
  const scratchDir = path.join(process.cwd(), '.scratch');
  return mkdir(scratchDir, { recursive: true }).then(() => mkdtemp(path.join(scratchDir, prefix)));
}

function createFakeClient() {
  const uploads = [];
  const createdJobs = [];

  const ocrResponse = {
    pages: [
      {
        index: 0,
        markdown: '# Batch OCR\n\nRecognized content.',
        images: [],
        dimensions: { dpi: 200, height: 100, width: 100 },
      },
    ],
    model: 'mistral-ocr-latest',
    usageInfo: { pagesProcessed: 1 },
  };

  const client = {
    files: {
      async upload(request) {
        uploads.push(request);
        return { id: `file-${uploads.length}` };
      },
      async download() {
        throw new Error('download should not be needed when inline outputs are returned');
      },
    },
    batch: {
      jobs: {
        async create(request) {
          createdJobs.push(request);
          return {
            id: 'job-1',
            inputFiles: [],
            endpoint: request.endpoint,
            model: request.model,
            errors: [],
            status: 'RUNNING',
            createdAt: 0,
            totalRequests: request.requests.length,
            completedRequests: 0,
            succeededRequests: 0,
            failedRequests: 0,
          };
        },
        async get(request) {
          return {
            id: request.jobId,
            inputFiles: [],
            endpoint: '/v1/ocr',
            model: 'mistral-ocr-latest',
            errors: [],
            outputs: [
              {
                customId: '0',
                response: {
                  body: ocrResponse,
                },
              },
            ],
            status: 'SUCCESS',
            createdAt: 0,
            totalRequests: 1,
            completedRequests: 1,
            succeededRequests: 1,
            failedRequests: 0,
          };
        },
      },
    },
  };

  return { client, uploads, createdJobs };
}

test('createOcrBatch submits OCR requests to the Mistral batch endpoint', async () => {
  const tmp = await createWorkspaceTemp('batch-create-');
  const pdfPath = path.join(tmp, 'sample.pdf');
  await writeFile(pdfPath, Buffer.from('%PDF-1.4\n% test\n'));

  const { client, uploads, createdJobs } = createFakeClient();
  const result = await createOcrBatch([pdfPath], { client, logger: false });

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].fileName, 'sample.pdf');
  assert.equal(uploads[0].purpose, 'ocr');
  assert.equal(createdJobs[0].endpoint, '/v1/ocr');
  assert.equal(createdJobs[0].model, 'mistral-ocr-latest');
  assert.deepEqual(createdJobs[0].requests[0], {
    customId: '0',
    body: {
      document: {
        type: 'file',
        file_id: 'file-1',
      },
      include_image_base64: true,
    },
  });
});

test('convertPdfBatch writes Markdown outputs from inline batch OCR results', async () => {
  const tmp = await createWorkspaceTemp('batch-convert-');
  const pdfPath = path.join(tmp, 'sample.pdf');
  const outputDir = path.join(tmp, 'out');
  await writeFile(pdfPath, Buffer.from('%PDF-1.4\n% test\n'));

  const { client } = createFakeClient();
  const result = await convertPdfBatch([pdfPath], {
    client,
    outputDir,
    generateDocx: false,
    writeImages: false,
    logger: false,
  });

  assert.equal(result.job.status, 'SUCCESS');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].markdownPath, path.join(outputDir, 'sample.md'));
  assert.equal(result.entries[0].error, undefined);

  const markdown = await readFile(path.join(outputDir, 'sample.md'), 'utf8');
  assert.match(markdown, /# Batch OCR/u);
  assert.match(markdown, /Recognized content/u);
});
