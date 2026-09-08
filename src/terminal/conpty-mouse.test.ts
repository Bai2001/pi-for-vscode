import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ConptyMouseRestorer,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  RESTORED_ON_ENTER,
  RESTORED_ON_EXIT,
} from "./conpty-mouse.ts";

test("disabled restorer passes data through", () => {
  const restorer = new ConptyMouseRestorer(false);
  const data = `${ENTER_ALT_SCREEN}\x1b[2J`;
  assert.equal(restorer.feed(data), data);
});

test("injects mouse tracking after entering the alternate screen", () => {
  const restorer = new ConptyMouseRestorer(true);
  assert.equal(
    restorer.feed(`${ENTER_ALT_SCREEN}\x1b[2J`),
    `${ENTER_ALT_SCREEN}${RESTORED_ON_ENTER}\x1b[2J`,
  );
});

test("injects mouse disable after leaving the alternate screen", () => {
  const restorer = new ConptyMouseRestorer(true);
  assert.equal(restorer.feed(EXIT_ALT_SCREEN), `${EXIT_ALT_SCREEN}${RESTORED_ON_EXIT}`);
});

test("reassembles a split 1049h sequence across chunks", () => {
  const restorer = new ConptyMouseRestorer(true);
  assert.equal(restorer.feed("\x1b[?10"), "");
  assert.equal(restorer.feed(`49h\x1b[2J`), `${ENTER_ALT_SCREEN}${RESTORED_ON_ENTER}\x1b[2J`);
});

test("does not swallow unrelated CSI sequences", () => {
  const restorer = new ConptyMouseRestorer(true);
  assert.equal(restorer.feed("\x1b[2J\x1b[H\x1b[?25l"), "\x1b[2J\x1b[H\x1b[?25l");
});

test("reset drops a pending partial sequence", () => {
  const restorer = new ConptyMouseRestorer(true);
  restorer.feed("\x1b[?10");
  restorer.reset();
  assert.equal(restorer.feed("49h"), "49h");
});
