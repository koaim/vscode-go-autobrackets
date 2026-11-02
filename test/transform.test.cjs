const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transform } = require('../out/transform');

function run(marked, removed = '', inserted = ',') {
  const offset = marked.indexOf('|');
  const before = marked.replace('|', '');
  assert.equal(before.slice(offset, offset + removed.length), removed);
  const change = { rangeOffset: offset, rangeLength: removed.length, text: inserted };
  const edit = transform(before, change);
  if (!edit) return undefined;
  const after = before.slice(0, offset) + inserted + before.slice(offset + removed.length);
  const result = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  return result.slice(0, edit.cursor) + '|' + result.slice(edit.cursor);
}

for (const type of [
  'int', '*pkg.Value', '[]byte', '[2]int', 'map[string][]*Thing',
  'chan int', '<-chan int', 'chan<- *T', 'Pair[A, B]',
  'struct { X, Y int }', 'interface { Read([]byte) (int, error) }',
  'func(int, string) (int, error)', 'func() int', 'func()', 'Результат',
]) {
  test(`wrap ${type}`, () => {
    assert.equal(run(`func foo() ${type}| {}`), `func foo() (${type}, |) {}`);
  });
  test(`unwrap ${type}`, () => {
    assert.equal(run(`func foo() (${type}|, ) {}`, ',', ''), `func foo() ${type}| {}`);
  });
}

for (const head of ['func foo()', 'func (s *Service) foo()', 'func (s *Service[T]) foo()', 'func foo[T any](x T)', 'var f = func()', 'type F func()']) {
  test(`signature ${head}`, () => assert.equal(run(`${head} int| {}`), `${head} (int, |) {}`));
}

test('preserves comments around types', () => {
  assert.equal(run('func foo() int /* unit */| {}'), 'func foo() (int /* unit */, |) {}');
  assert.equal(run('func foo() (/* unit */ int|, ) {}', ',', ''), 'func foo() /* unit */ int| {}');
});
test('deleting comma and second result unwraps', () => {
  assert.equal(run('func foo() (int|, error) {}', ', error', ''), 'func foo() int| {}');
});
test('deleting first result and comma unwraps', () => {
  assert.equal(run('func foo() (|int, error) {}', 'int, ', ''), 'func foo() |error {}');
});
test('multiline result and CRLF', () => {
  assert.equal(run('func foo(\r\n x int,\r\n) int| {}'), 'func foo(\r\n x int,\r\n) (int, |) {}');
  assert.equal(run('func foo() (\n int|,\n) {}', ',', ''), 'func foo() int| {}');
});
for (const input of [
  'func foo(x int|) {}', 'func foo() (int|) {}', 'func foo() (int|, error) {}',
  'func foo() { x := 1| }', '// func foo() int|', 'var s = "func foo() int|"',
  'var s = `func foo() int|`', '/* func foo() int| */',
  'func foo() Pair[A|, B] {}', 'func foo() struct { A int| } {}',
  'func foo() func(a int|) {}', 'var n int|',
  'func NewManagerWithOpts[T any](conn *gorm.DB, opts *sql.TxOptions, wrapToTx func(*gorm.DB) T|) *Manager[T] {\n\treturn &Manager[T]{conn: conn, wrapToTx: wrapToTx, opts: opts}\n}',
  'func foo(callback func() int|, next string) {}',
  'func (s *Service) foo(callback func() int|) {}',
  'type F func(callback func() int|)',
  'var f = func(callback func() int|) {}',
  'func foo(callback func(inner func() int|)) {}',
]) {
  test(`ignore comma in ${input}`, () => assert.equal(run(input), undefined));
}
for (const [input, removed] of [
  ['func foo() (n int|, ) {}', ','],
  ['func foo() (int|, error) {}', ','],
  ['func foo() (int|, string, error) {}', ', string'],
  ['func foo() (Pair[A|, B]) {}', ', B'],
  ['func foo(x int|, y int) {}', ', y int'],
  ['func foo(callback func() (int|, )) {}', ','],
  ['func foo() (int // comment\n |, ) {}', ','],
  ['func foo() (|, ) {}', ','],
]) {
  test(`retain parentheses in ${input}`, () => assert.equal(run(input, removed, ''), undefined));
}
test('other keystrokes do nothing', () => assert.equal(run('func foo() int| {}', '', '('), undefined));
