// Local save only. The later sync debounce is a different clock and must
// not be what writes the note onto the device.

export function createDebouncedSaver({ delay = 400, write, onStatus } = {}) {
  if (typeof write !== 'function') {
    throw new Error('A saver needs a write function.');
  }
  let timer = null;
  let dirty = false;
  let getter = () => null;
  let chain = Promise.resolve();
  let epoch = 0;

  function schedule(getNote) {
    getter = getNote;
    dirty = true;
    onStatus?.('saving');
    clearTimeout(timer);
    timer = setTimeout(() => {
      flush();
    }, delay);
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!dirty) return chain;
    dirty = false;
    const generation = epoch + 1;
    epoch = generation;
    const note = { ...getter() };
    let result;
    try {
      result = write(note);
    } catch (error) {
      result = Promise.reject(error);
    }
    const job = Promise.resolve(result).then(
      () => {
        if (generation === epoch && !dirty) onStatus?.('saved');
      },
      (error) => {
        if (generation === epoch && !dirty) {
          dirty = true;
          onStatus?.('error', error);
        } else if (generation === epoch) {
          dirty = true;
        }
        throw error;
      },
    );
    chain = job.then(() => {}, () => {});
    return job;
  }

  function discard() {
    clearTimeout(timer);
    timer = null;
    dirty = false;
    epoch += 1;
    return chain;
  }

  return {
    schedule,
    flush,
    discard,
    get pending() {
      return dirty;
    },
  };
}
