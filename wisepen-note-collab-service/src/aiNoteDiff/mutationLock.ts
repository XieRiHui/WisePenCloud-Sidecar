const locks = new Map<string, Promise<void>>();

export async function withRoomMutationLock<T>(resourceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(resourceId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = prev.then(() => gate);
  locks.set(resourceId, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(resourceId) === next) {
      locks.delete(resourceId);
    }
  }
}
