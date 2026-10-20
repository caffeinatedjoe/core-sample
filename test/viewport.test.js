import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutFrame } from '../app/js/viewport.js';

// Joe's iPhone, Home Screen standalone, keyboard closed, portrait.
// innerHeight is a status-bar short of the screen. safe-bottom is the home indicator.
const joe = {
  innerHeight: 797,
  screenWidth: 390,
  screenHeight: 844,
  visualViewportHeight: 797,
  visualViewportOffsetTop: 0,
  standalone: true,
  landscape: false,
  safeBottom: 34,
};

test('a short standalone viewport pads scroll content by the screen gap', () => {
  const frame = layoutFrame(joe);
  assert.equal(frame.keyboard, 0);
  assert.equal(frame.screenSpan, 844);
  assert.equal(frame.gap, 47);
  assert.equal(frame.scrollPad, 47);
});

test('the 47px status-bar gap is not treated as a keyboard', () => {
  const frame = layoutFrame({ ...joe, visualViewportHeight: 797 - 47 });
  assert.equal(797 - (797 - 47), 47);
  assert.equal(frame.keyboard, 0);
  assert.equal(frame.gap, 47);
  assert.equal(frame.scrollPad, 47);
});

test('an open keyboard is the overlap and does not change the scroll pad', () => {
  const frame = layoutFrame({ ...joe, visualViewportHeight: 400, visualViewportOffsetTop: 0 });
  assert.equal(frame.keyboard, 397);
  assert.equal(frame.gap, 47);
  assert.equal(frame.scrollPad, 47);
});

test('visualViewport offsetTop counts toward the keyboard overlap', () => {
  const frame = layoutFrame({ ...joe, visualViewportHeight: 500, visualViewportOffsetTop: 40 });
  assert.equal(frame.keyboard, 257);
  assert.equal(frame.gap, 47);
});

test('once innerHeight matches the screen, padding is only the home indicator', () => {
  const frame = layoutFrame({
    ...joe,
    innerHeight: 844,
    visualViewportHeight: 844,
  });
  assert.equal(frame.keyboard, 0);
  assert.equal(frame.gap, 0);
  assert.equal(frame.scrollPad, 34);
});

test('a home indicator larger than the gap still wins', () => {
  const frame = layoutFrame({
    ...joe,
    innerHeight: 830,
    visualViewportHeight: 830,
    safeBottom: 34,
  });
  assert.equal(frame.gap, 14);
  assert.equal(frame.scrollPad, 34);
});

test('landscape uses the short screen side, not screen.height', () => {
  const frame = layoutFrame({
    ...joe,
    innerHeight: 353,
    visualViewportHeight: 353,
    landscape: true,
  });
  assert.equal(frame.keyboard, 0);
  assert.equal(frame.screenSpan, 390);
  assert.equal(frame.gap, 37);
  assert.equal(frame.scrollPad, 37);
  assert.notEqual(frame.screenSpan, joe.screenHeight);
});

test('landscape innerHeight that already matches the short side has no gap', () => {
  const frame = layoutFrame({
    ...joe,
    innerHeight: 390,
    visualViewportHeight: 390,
    landscape: true,
  });
  assert.equal(frame.gap, 0);
  assert.equal(frame.scrollPad, 34);
});

test('a browser tab does not pad for the screen gap', () => {
  const frame = layoutFrame({
    ...joe,
    standalone: false,
    innerHeight: 800,
    visualViewportHeight: 800,
    safeBottom: 0,
  });
  assert.equal(frame.keyboard, 0);
  assert.equal(frame.gap, 0);
  assert.equal(frame.scrollPad, 0);
  assert.equal(frame.screenSpan, 844);
});
