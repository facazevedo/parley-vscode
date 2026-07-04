import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeScreenshotRequest, wantsPixelCoordinates } from '../src/computer/screenshotIntent';

test('matches clear capture-my-screen requests', () => {
  for (const s of [
    'paste a screenshot of my main monitor',
    'take a screenshot',
    'take a screenshot of my screen',
    'screenshot my monitor',
    'capture my screen',
    'grab a screenshot of my desktop',
    'show me a screenshot of my display',
    'can you snap my screen'
  ]) {
    assert.equal(looksLikeScreenshotRequest(s), true, s);
  }
});

test('ignores how-to questions and coding tasks that mention screenshots', () => {
  for (const s of [
    'how do I take a screenshot in Blender',
    'how to capture my screen on Windows',
    'add a screenshot button to the toolbar',
    'implement screenshot capture in the app',
    'the screenshot looks blurry',
    'where is the screenshot saved',
    'check the screen resolution setting',
    'write a function that captures the screen'
  ]) {
    assert.equal(looksLikeScreenshotRequest(s), false, s);
  }
});

test('ignores empty or very long messages', () => {
  assert.equal(looksLikeScreenshotRequest(''), false);
  assert.equal(looksLikeScreenshotRequest('take a screenshot of my screen ' + 'x'.repeat(200)), false);
});

test('wantsPixelCoordinates detects location/pixel questions', () => {
  for (const s of [
    'which pixel is the render button',
    'what are the coordinates of the Save button',
    'where is the mirror menu exactly',
    'give me the x,y of the hex hub',
    'the position of the outliner panel'
  ]) {
    assert.equal(wantsPixelCoordinates(s), true, s);
  }
  for (const s of ['what is on my screen', 'describe my screen', 'take a screenshot']) {
    assert.equal(wantsPixelCoordinates(s), false, s);
  }
});
