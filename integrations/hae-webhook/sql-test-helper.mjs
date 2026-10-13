import { DatabaseSync } from 'node:sqlite';
export function testSql() {
  const db = new DatabaseSync(':memory:');
  return { exec(query, ...args) {
    const statement = db.prepare(query);
    const rows = statement.all(...args);
    return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
  }, db };
}
