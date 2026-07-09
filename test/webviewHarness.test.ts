import './fakeVscode'; // installs the `vscode` module double — must be imported first
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import * as vscode from 'vscode';
import { buildChatHtml } from '../src/webview/webviewHtml';

/**
 * Interaction-level tests for the chat webview. The real bundle (dist/webview.js —
 * media/chat.js + markdown-it + highlight.js) is loaded into a jsdom document built
 * from the actual buildChatHtml() shell, with acquireVsCodeApi stubbed to capture
 * postMessage. This exercises the DOM glue the pure-logic tests can't (menus,
 * chips, steer bubbles, snippet flow). Requires `npm run compile` first (npm test does).
 */

const BUNDLE = path.join(__dirname, '..', '..', 'dist', 'webview.js');

function loadWebview() {
  assert.ok(fs.existsSync(BUNDLE), `bundle not built: ${BUNDLE} (run npm run compile)`);
  const webview = { asWebviewUri: (u: unknown) => u, cspSource: '' } as unknown as vscode.Webview;
  const html = buildChatHtml(webview, vscode.Uri.file(process.cwd()));
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://localhost/' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = dom.window as any;
  win.Element.prototype.scrollIntoView = () => {}; // jsdom doesn't implement it
  const posted: Array<Record<string, unknown>> = [];
  win.acquireVsCodeApi = () => ({
    postMessage: (m: Record<string, unknown>) => posted.push(m),
    getState: () => undefined,
    setState: () => undefined
  });
  win.eval(fs.readFileSync(BUNDLE, 'utf8')); // runs the IIFE bundle in this window
  const doc = win.document;
  return {
    win,
    doc,
    posted,
    $: (id: string) => doc.getElementById(id),
    send: (data: Record<string, unknown>) => win.dispatchEvent(new win.MessageEvent('message', { data })),
    click: (el: Element) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })),
    mousedown: (el: Element) => el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true })),
    fire: (el: Element, type: string) => el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }))
  };
}

test('webview bundle loads and wires the composer', () => {
  const w = loadWebview();
  assert.ok(w.$('prompt'), 'composer textarea present');
  assert.ok(w.$('addMenu'), '+ menu present');
});

test('+ Add menu opens on click and closes on outside click', () => {
  const w = loadWebview();
  assert.equal(w.$('addMenu').style.display, 'none');
  w.click(w.$('addMenuBtn'));
  assert.equal(w.$('addMenu').style.display, 'block');
  w.click(w.doc.body); // outside click
  assert.equal(w.$('addMenu').style.display, 'none');
});

test('submitting the composer posts { type: "send" }', () => {
  const w = loadWebview();
  w.$('prompt').value = 'hello world';
  w.fire(w.$('composer'), 'submit');
  const sent = w.posted.find((m) => m.type === 'send');
  assert.ok(sent, 'a send message was posted');
  assert.equal(sent!.prompt, 'hello world');
});

test('toggling a context chip updates the summary and posts contextOptionsChanged', () => {
  const w = loadWebview();
  const diag = w.$('includeDiagnostics');
  diag.checked = true;
  w.fire(diag, 'change');
  const msg = w.posted.find((m) => m.type === 'contextOptionsChanged');
  assert.ok(msg, 'contextOptionsChanged posted');
  assert.equal((msg!.contextOptions as Record<string, boolean>).includeDiagnostics, true);
  assert.match(w.$('ctxSummary').textContent, /Diagnostics/);
});

test('a queued steering message renders a pending bubble and a chip', () => {
  const w = loadWebview();
  w.send({ type: 'queued', steering: ['please stop'], followUps: [] });
  const pending = w.doc.querySelector('.message.user.pendingsteer');
  assert.ok(pending, 'pending steer bubble rendered');
  assert.match(pending!.textContent ?? '', /please stop/);
  assert.match(w.$('queued').textContent, /please stop/); // chip too
});

test('snippet insert: menu item requests the list, which renders and inserts', () => {
  const w = loadWebview();
  w.click(w.$('addMenuBtn'));
  const insertItem = w.$('addMenu').querySelector('[data-add="snippet-insert"]');
  w.click(insertItem!);
  assert.ok(
    w.posted.some((m) => m.type === 'openSnippets'),
    'openSnippets requested'
  );
  w.send({ type: 'snippetList', items: [{ name: 'Greeting', text: 'Hello from a snippet' }] });
  const menu = w.$('menuPanel');
  assert.notEqual(menu.style.display, 'none');
  const row = [...menu.querySelectorAll('.mn-item')].find((r) => /Greeting/.test(r.textContent ?? ''));
  assert.ok(row, 'snippet row rendered');
  w.mousedown(row!); // menuPanel rows pick on mousedown
  assert.match(w.$('prompt').value, /Hello from a snippet/);
});

test('app-bar overflow menu lists Usage, Refresh, and Settings', () => {
  const w = loadWebview();
  w.click(w.$('appMore'));
  const menu = w.$('menuPanel');
  assert.notEqual(menu.style.display, 'none');
  assert.match(menu.textContent, /Usage/);
  assert.match(menu.textContent, /Refresh/);
  assert.match(menu.textContent, /Settings/);
});

function proposeApproval(w: ReturnType<typeof loadWebview>, id = 'apr-1') {
  w.send({
    type: 'proposedChange',
    id,
    path: 'a.ts',
    isNew: false,
    added: 1,
    removed: 0,
    rows: [{ kind: 'add', newNo: 1, text: 'x' }]
  });
}

test('diff-review shortcut: Ctrl+Enter applies the pending approval card', () => {
  const w = loadWebview();
  proposeApproval(w);
  w.doc.dispatchEvent(new w.win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  const applied = w.posted.find((m) => m.type === 'applyChange' && m.id === 'apr-1');
  assert.ok(applied, 'applyChange posted for the pending card');
  assert.ok(!applied!.all, 'single apply, not apply-all');
});

test('diff-review shortcut: Ctrl+Shift+Backspace rejects all', () => {
  const w = loadWebview();
  proposeApproval(w);
  w.doc.dispatchEvent(
    new w.win.KeyboardEvent('keydown', { key: 'Backspace', ctrlKey: true, shiftKey: true, bubbles: true })
  );
  const rejected = w.posted.find((m) => m.type === 'dismissChange' && m.id === 'apr-1');
  assert.ok(rejected, 'dismissChange posted');
  assert.equal(rejected!.all, true);
});

test('diff-review shortcut: plain Enter does not resolve a card (it sends)', () => {
  const w = loadWebview();
  proposeApproval(w);
  w.doc.dispatchEvent(new w.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.ok(!w.posted.some((m) => m.type === 'applyChange'), 'plain Enter must not apply the pending edit');
});

test('code fences are syntax-highlighted, including auto-detected (no language tag)', () => {
  const w = loadWebview();
  // A user (steer) bubble goes through renderMd; a language-less fence must still colorize.
  w.send({ type: 'queued', steering: ['```\nfunction hi() { return 42; }\n```'], followUps: [] });
  const bubble = w.doc.querySelector('.message.user.pendingsteer');
  assert.ok(bubble, 'bubble rendered');
  assert.match(bubble!.innerHTML, /class="hljs-/, 'code is auto-highlighted with hljs token spans');
});

test('run_command tool step shows the command syntax-highlighted', () => {
  const w = loadWebview();
  w.send({ type: 'toolEvent', name: 'run_command', args: '{"command":"echo hello world"}' });
  w.send({ type: 'toolResult', text: 'ok', detail: 'hello world' });
  const pre = w.doc.querySelector('.toolstep .tooldetail pre');
  assert.ok(pre, 'expanded command/arguments pane present');
  assert.match(pre!.innerHTML, /class="hljs-/, 'the command is syntax-highlighted');
});

test('question navigator: prev/next highlights your messages one at a time', () => {
  const w = loadWebview();
  const hist = w.$('history');
  hist.innerHTML =
    '<div class="message user"><div class="content">Q1</div></div>' +
    '<div class="message user"><div class="content">Q2</div></div>' +
    '<div class="message user"><div class="content">Q3</div></div>';
  const qs = () => [...hist.querySelectorAll('.message.user')];
  const highlighted = () => qs().findIndex((q: Element) => q.classList.contains('qnav-highlight'));

  w.click(w.$('prevQuestion')); // first Prev → newest (Q3)
  assert.equal(highlighted(), 2);
  w.click(w.$('prevQuestion')); // → Q2 (only one highlighted at a time)
  assert.equal(highlighted(), 1);
  assert.equal(hist.querySelectorAll('.qnav-highlight').length, 1);
  w.click(w.$('nextQuestion')); // → Q3
  assert.equal(highlighted(), 2);
  w.click(w.$('prevQuestion')); // Q2
  w.click(w.$('prevQuestion')); // Q1 (oldest)
  w.click(w.$('prevQuestion')); // clamps at Q1
  assert.equal(highlighted(), 0);
});
