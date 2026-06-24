import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MODEL } from '../build/index.js';

test('exports Mistral OCR 4 as the default model', () => {
  assert.equal(DEFAULT_MODEL, 'mistral-ocr-4-0');
});
