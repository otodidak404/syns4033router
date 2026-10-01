// Runtime test for caveman injector — covers every wire format shape plus the
// idempotency guard shared with modelSkill.js.
import assert from "assert";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { injectCaveman } = await import(path.join(HERE, "open-sse/rtk/caveman.js"));
const { CAVEMAN_LEVELS } = await import(path.join(HERE, "open-sse/rtk/cavemanPrompts.js"));
const { FORMATS } = await import(path.join(HERE, "open-sse/translator/formats.js"));

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const L = CAVEMAN_LEVELS.FULL;

console.log("caveman");

t('unknown level is a no-op', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  assert.strictEqual(injectCaveman(body, FORMATS.OPENAI, 'nonsense'), false);
  assert.strictEqual(body.messages.length, 1);
});

t('openai: appends after existing system text', () => {
  const body = { messages: [{ role: 'system', content: 'ORIGINAL' }] };
  assert.strictEqual(injectCaveman(body, FORMATS.OPENAI, L), true);
  assert.ok(body.messages[0].content.startsWith('ORIGINAL'));
  assert.ok(body.messages.length === 1);
});

t('openai: developer role is a valid merge target', () => {
  const body = { messages: [{ role: 'developer', content: 'ORIGINAL' }] };
  injectCaveman(body, FORMATS.OPENAI, L);
  assert.strictEqual(body.messages.length, 1, 'must reuse developer, not add system');
  assert.ok(body.messages[0].content.includes('ORIGINAL'));
});

t('claude: string system', () => {
  const body = { system: 'ORIGINAL' };
  injectCaveman(body, FORMATS.CLAUDE, L);
  assert.ok(body.system.startsWith('ORIGINAL'));
});

t('claude: empty-string system is replaced, not concatenated', () => {
  const body = { system: '' };
  injectCaveman(body, FORMATS.CLAUDE, L);
  assert.ok(body.system.length > 0);
  assert.ok(!body.system.startsWith('\n\n'));
});

t('claude: inserts before cache_control breakpoint', () => {
  const body = { system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } }] };
  injectCaveman(body, FORMATS.CLAUDE, L);
  assert.strictEqual(body.system.length, 3);
  assert.ok(body.system[2].cache_control, 'breakpoint remains last');
});

t('gemini: merges into existing parts, no new part', () => {
  const body = { system_instruction: { parts: [{ text: 'ORIGINAL' }] } };
  injectCaveman(body, FORMATS.GEMINI, L);
  assert.strictEqual(body.system_instruction.parts.length, 1);
  assert.ok(body.system_instruction.parts[0].text.includes('ORIGINAL'));
});

t('antigravity: targets body.request wrapper', () => {
  const body = { request: {} };
  injectCaveman(body, FORMATS.ANTIGRAVITY, L);
  assert.ok(body.request.systemInstruction.parts.length === 1);
});

t('responses: instructions string', () => {
  const body = { instructions: 'ORIGINAL' };
  injectCaveman(body, FORMATS.OPENAI_RESPONSES, L);
  assert.ok(body.instructions.startsWith('ORIGINAL'));
});

t('responses: empty instructions does not gain leading separators', () => {
  const body = { instructions: '' };
  injectCaveman(body, FORMATS.OPENAI_RESPONSES, L);
  assert.ok(!body.instructions.startsWith('\n\n'));
});

t('content-array system message merges into the last text part', () => {
  const body = { messages: [{ role: 'system', content: [{ type: 'text', text: 'ORIGINAL' }] }] };
  injectCaveman(body, FORMATS.OPENAI, L);
  // Merged, not appended as a new part: keeps the part count stable so a
  // provider-side prompt cache keyed on structure still hits.
  assert.strictEqual(body.messages[0].content.length, 1);
  assert.ok(body.messages[0].content[0].text.startsWith('ORIGINAL'));
});

t('content-array system message merges into a trailing non-text part safely', () => {
  const body = { messages: [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] };
  injectCaveman(body, FORMATS.OPENAI, L);
  assert.strictEqual(body.messages[0].content.length, 2, 'appends a text part after a non-text one');
  assert.strictEqual(body.messages[0].content[1].type, 'input_text');
  assert.deepStrictEqual(body.messages[0].content[0], { type: 'image_url', image_url: { url: 'x' } }, 'non-text part untouched');
});

t('body with no recognizable slot returns false', () => {
  const body = { foo: 'bar' };
  assert.strictEqual(injectCaveman(body, FORMATS.OPENAI, L), false);
});

console.log(`\n${pass} passed${process.exitCode ? ', some failed' : ''}`);