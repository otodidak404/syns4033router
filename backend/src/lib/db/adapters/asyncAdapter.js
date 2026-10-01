import { AsyncLocalStorage } from "node:async_hooks";

export function createAsyncAdapter(adapter) {
  const transactionStorage = new AsyncLocalStorage();
  let queue = Promise.resolve();

  function enqueue(fn) {
    const result = queue.then(fn, fn);
    queue = result.catch(() => {});
    return result;
  }

  function execute(fn) {
    if (transactionStorage.getStore()) {
      return Promise.resolve().then(fn);
    }
    return enqueue(fn);
  }

  async function runTransaction(fn) {
    const savepoint = `sp_${Math.random().toString(36).slice(2)}`;
    adapter.exec(`SAVEPOINT ${savepoint}`);
    try {
      const value = await transactionStorage.run({ active: true }, fn);
      adapter.exec(`RELEASE ${savepoint}`);
      return value;
    } catch (error) {
      try {
        adapter.exec(`ROLLBACK TO ${savepoint}`);
        adapter.exec(`RELEASE ${savepoint}`);
      } catch {}
      throw error;
    }
  }

  return {
    driver: adapter.driver,
    run(sql, params = []) {
      return execute(() => adapter.run(sql, params));
    },
    get(sql, params = []) {
      return execute(() => adapter.get(sql, params));
    },
    all(sql, params = []) {
      return execute(() => adapter.all(sql, params));
    },
    exec(sql) {
      return execute(() => adapter.exec(sql));
    },
    transaction(fn) {
      if (transactionStorage.getStore()) return runTransaction(fn);
      return enqueue(() => runTransaction(fn));
    },
    checkpoint() {
      return execute(() => adapter.checkpoint?.());
    },
    close() {
      return enqueue(() => adapter.close?.());
    },
    raw: adapter.raw,
  };
}
