import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panelScript = readFileSync(new URL('../sidepanel/panel.js', import.meta.url), 'utf8');
const panelStyles = readFileSync(new URL('../sidepanel/panel.css', import.meta.url), 'utf8');

test('read titles remain plain text instead of fixed per-line DOM', () => {
  assert.doesNotMatch(panelScript, /splitStrikethroughLines|createElement\(['"]s['"]\)/);
  assert.match(panelStyles, /box-decoration-break:\s*clone/);
});

test('panel entrance animation is explicitly replayed when the panel becomes visible', () => {
  assert.match(panelScript, /function restartPanelEnterAnimation/);
  assert.match(panelScript, /visibilitychange/);
  assert.match(panelStyles, /#app\.panel-enter[\s\S]*animation:\s*slideIn/);
});
