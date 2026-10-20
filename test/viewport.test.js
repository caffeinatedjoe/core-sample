import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutFrame } from '../app/js/viewport.js';

// Joe's iPhone, Home Screen standalone, keyboard closed, portrait.
const joe = {
  innerHeight: 797,
  outerHeight: 844,
  screenWidth: 390,
  screenHeight: 844,
  visualViewportHeight: 797,
  visualViewportOffsetTop: 0,
  standalone: true,
  landscape: false,
};

test('standalone portrait sizes the frame to outerHeight, not innerHeight', () => {
  const frame = layoutFrame(joe);
  assert.equal(frame.keyboard, 0);
  assert.equal(frame.full, 844);
  assert.equal(frame.appH, 844);
  assert.equal(frame.source, 'outerHeight');
  assert.notEqual(frame.appH, joe.innerHeight);
});

test('the 47px status-bar gap is not treated as a keyboard', () => {
  const frame = layoutFrame({ ...joe, visualViewportHeight: 797 - 47 });
  assert.equal(797 - (797 - 47), 47);
  assert.equal(frame.keyboard, 0);
  assert.equal(frame.appH, 844);
  assert.equal(frame.source, 'outerHeight');
});

test('an open keyboard shrinks the full height, not the short layout viewport', () => {
  const frame = layoutFrame({ ...joe, visualViewportHeight: 400, visualViewportOffsetTop: 0 });
  assert.equal(frame.keyboard, 397);
  assert.equal(frame.full, 844);
  assert.equal(frame.appH, 447);
});

test('visualViewport offsetTop counts toward the keyboard overlap', () => {
  const frame = layoutFrame({ ...joe, visualViewportHeight: 500, visualViewportOffsetTop: 40 });
  assert.equal(frame.keyboard, 257);
  assert.equal(frame.appH, 844 - 257);
});

test('landscape uses outerHeight even though screen.height stays portrait', () => {
  const frame = layoutFrame({
    ...joe,
    innerHeight: 390,
    outerHeight: 390,
    visualViewportHeight: 390,
    landscape: true,
  });
  assert.equal(frame.keyboard, 0);
  assert.equal(frame.appH, 390);
  assert.equal(frame.full, 390);
  assert.equal(frame.source, 'outerHeight');
  assert.notEqual(frame.appH, joe.screenHeight);
});

test('landscape without outerHeight uses the short screen side', () => {
  const frame = layoutFrame({
    ...joe,
    innerHeight: 353,
    outerHeight: 0,
    visualViewportHeight: 353,
    landscape: true,
  });
  assert.equal(frame.full, 390);
  assert.equal(frame.appH, 390);
  assert.equal(frame.source, 'screen');
});

test('portrait without outerHeight uses the long screen side', () => {
  const frame = layoutFrame({ ...joe, outerHeight: 0 });
  assert.equal(frame.full, 844);
  assert.equal(frame.appH, 844);
  assert.equal(frame.source, 'screen');
});

test('a browser tab stays on innerHeight', () => {
  const frame = layoutFrame({
    ...joe,
    standalone: false,
    innerHeight: 800,
    outerHeight: 900,
    visualViewportHeight: 800,
  });
  assert.equal(frame.keyboard, 0);
  assert.equal(frame.appH, 800);
  assert.equal(frame.full, 800);
  assert.equal(frame.source, 'innerHeight');
});
