import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const server = await readFile(new URL('server.mjs', root), 'utf8');
const css = await readFile(new URL('ui.css', root), 'utf8');

test('新建任务提供聊天和工作模式选择', () => {
  assert.match(server, /id="newTaskModeOverlay"/);
  assert.match(server, /id="newTaskChatTab"[^>]*>聊天/);
  assert.match(server, /id="newTaskWorkTab"[^>]*>工作/);
  assert.match(server, /id="newTaskChatModel"[^>]*aria-label="聊天模型"/);
  assert.match(server, /CHATGPT_DEFAULT_MODEL = Object\.freeze\(\{ id: 'gpt-6-pro', displayName: '6 Pro' \}\)/);
  assert.match(server, /function syncChatGPTComposerModelSelect\(\)/);
  assert.match(server, /currentConversationSource==='chatgpt'/);
  assert.match(server, /function syncNewTaskChatModelOptions\(\)/);
  assert.match(server, /newTaskModeChatSettings\?\.toggleAttribute\('hidden',!chatSelected\)/);
  assert.match(server, /document\.getElementById\('newChat'\)\?\.addEventListener\('click', openNewTaskModePicker\)/);
  assert.match(server, /newTaskModeConfirm\?\.addEventListener\('click',confirmNewTaskMode\)/);
  assert.match(server, /function startNewChatMode\(mode='work',selectedModel=''\)/);
  assert.match(server, /startNewChatMode\('chat',selectedModel\)/);
  assert.match(server, /selectComposerModel\(chatModel\)/);
  assert.match(server, /currentConversationSource='web'/);
  assert.match(server, /async function sendLegacyChatMessage/);
  assert.match(server, /fetch\('\/api\/chat'/);
  assert.match(css, /\.newTaskModeOverlay/);
  assert.match(css, /\.newTaskModeChatSettings/);
});

test('新建任务模式标签支持标准键盘切换和单一焦点入口', () => {
  const start = server.indexOf('function setNewTaskModeChoice(mode){');
  const end = server.indexOf('\nfunction openNewTaskModePicker(){', start);
  assert.ok(start >= 0 && end > start);
  const element = () => ({
    attributes: {}, tabIndex: 0, focused: false, textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    toggleAttribute() {},
    focus() { this.focused = true; },
  });
  const chat = element();
  const work = element();
  const context = {
    newTaskModeChoice: 'work', newTaskChatTab: chat, newTaskWorkTab: work,
    newTaskModeChatSettings: element(), newTaskModePreviewTitle: element(),
    newTaskModePreviewText: element(), newTaskModeConfirm: element(),
    newTaskModePreview: { querySelector: () => null },
    syncNewTaskChatModelOptions() {}, setIconLabel() {},
  };
  vm.createContext(context);
  vm.runInContext(server.slice(start, end), context);

  context.setNewTaskModeChoice('chat');
  assert.equal(chat.attributes['aria-selected'], 'true');
  assert.equal(work.attributes['aria-selected'], 'false');
  assert.equal(chat.tabIndex, 0);
  assert.equal(work.tabIndex, -1);

  let prevented = false;
  context.handleNewTaskModeTabKey({
    target: chat, key: 'ArrowRight', preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(chat.tabIndex, -1);
  assert.equal(work.tabIndex, 0);
  assert.equal(work.focused, true);
});
